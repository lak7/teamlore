'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const agents = require('../agents');
const ui = require('../ui');
const toml = require('../toml');
const {
  KIMI_SKILL_DIR,
  KIMI_SENTINEL_FILE,
  KIMI_CONFIG_FILE,
} = require('../constants');

/*
 * Kimi Code adapter.
 *
 * Hooks live only in ~/.kimi-code/config.toml (user-level, CONFIRMED) and
 * only UserPromptSubmit can inject context (SessionStart is observation-only,
 * Stop would force a model continuation) → exactly one stanza is appended at
 * EOF via lib/toml.js. Commands are absolute with forward slashes and point
 * at the machine-global skill copy; scripts take `--host kimi` and answer in
 * plain text (frozen A2 contract). An unsafe TOML file is never touched: the
 * exact stanza is surfaced as manual instructions instead.
 */

function detect(root) {
  return fs.existsSync(path.join(root, '.kimi-code'));
}

function userConfigPath() {
  return path.join(os.homedir(), '.kimi-code', KIMI_CONFIG_FILE);
}

// True when the user-level config already carries teamlore hook stanzas.
function globallyWired() {
  try {
    return toml.hasTeamloreStanzas(fs.readFileSync(userConfigPath(), 'utf8'));
  } catch (_) {
    return false;
  }
}

function userSkillDir() {
  return path.join(os.homedir(), '.kimi-code', 'skills', 'teamlore');
}

function command() {
  const dir = userSkillDir().split(path.sep).join('/');
  return 'node "' + dir + '/scripts/recall.js" prompt --host kimi';
}

function stanzaText() {
  const cmd = command().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return (
    '[[hooks]]\n' +
    'event = "UserPromptSubmit"\n' +
    'command = "' + cmd + '"\n'
  );
}

// Install (consent-gated machine-global part). Throws an error carrying the
// exact stanza as manual instructions when the TOML is unsafe or not valid
// UTF-8 — no write.
function wireUserConfig() {
  const configPath = userConfigPath();
  agents.ensureDir(path.dirname(configPath));
  let buf = null;
  try {
    buf = fs.readFileSync(configPath);
  } catch (_) {
    buf = null;
  }
  if (buf !== null) {
    try {
      toml.assertValidUtf8(buf);
    } catch (err) {
      err.message =
        'Could not safely edit ' + userConfigPath() + ' — add this manually:\n\n' +
        stanzaText() + '\n(' + err.message + ')';
      throw err;
    }
  }
  const text = buf === null ? '' : buf.toString('utf8');
  if (toml.hasTeamloreStanzas(text)) return { changed: false };
  const stanzas = [{ event: 'UserPromptSubmit', command: command() }];
  let merged;
  try {
    merged = toml.appendHookStanzas(text, stanzas);
  } catch (err) {
    if (err && err.name === 'TomlUnsafeError') {
      err.message =
        'Could not safely edit ' + userConfigPath() + ' — add this manually:\n\n' +
        stanzaText() + '\n(' + err.message + ')';
    }
    throw err;
  }
  agents.writeAtomic(configPath, merged);
  return { changed: true };
}

function install(root, ctx) {
  const rows = [];
  const warnings = [];
  const { cyan, dim } = ui;
  let changed = false;

  // Project: skill copy + sentinel gitignore line.
  const skillRow = agents.skillRow(
    agents.copySkill(path.join(root, KIMI_SKILL_DIR), ctx.templatesDir, KIMI_SKILL_DIR),
    'skill',
    KIMI_SKILL_DIR + '/'
  );
  if (skillRow.changed) changed = true;
  rows.push(skillRow);
  if (agents.ensureGitignoreLine(path.join(root, '.gitignore'), KIMI_SENTINEL_FILE)) {
    changed = true;
  }

  // Machine-global (explicit --agents consent only).
  if (ctx.globalConsent) {
    const userSkillRow = agents.skillRow(
      agents.copySkill(userSkillDir(), ctx.templatesDir, KIMI_SKILL_DIR),
      'skill',
      '~/.kimi-code/skills/teamlore/'
    );
    if (userSkillRow.changed) changed = true;
    rows.push(userSkillRow);

    const wired = wireUserConfig();
    if (wired.changed) changed = true;
    rows.push({
      changed: wired.changed,
      label: 'hooks',
      filePath: '~/.kimi-code/config.toml',
      note: wired.changed ? cyan('UserPromptSubmit') : dim('already wired'),
    });
  }

  return { rows, warnings, changed };
}

function uninstall(root) {
  const rows = [];
  const warnings = [];
  const { green, dim } = ui;
  let changed = false;

  // Project.
  const skillRemoved = agents.rmrf(path.join(root, KIMI_SKILL_DIR));
  if (skillRemoved) changed = true;
  rows.push({
    changed: skillRemoved,
    label: 'skill',
    filePath: KIMI_SKILL_DIR + '/',
    note: skillRemoved ? green('removed') : dim('not present'),
  });
  if (agents.cleanGitignoreLines(path.join(root, '.gitignore'), [KIMI_SENTINEL_FILE])) {
    changed = true;
  }

  // Machine-global: strip only teamlore-owned lines (key-level); every other
  // byte is preserved. Ambiguous stanzas are left untouched and surfaced as
  // manual instructions; non-UTF-8 / structurally unsafe files are refused.
  const userSkillRemoved = agents.rmrf(userSkillDir());
  if (userSkillRemoved) changed = true;
  rows.push({
    changed: userSkillRemoved,
    label: 'skill',
    filePath: '~/.kimi-code/skills/teamlore/',
    note: userSkillRemoved ? green('removed') : dim('not present'),
  });

  const configPath = userConfigPath();
  let unwired = 0;
  if (fs.existsSync(configPath)) {
    try {
      const buf = fs.readFileSync(configPath);
      toml.assertValidUtf8(buf);
      const text = buf.toString('utf8');
      toml.assertSafe(text); // refuse-to-touch structurally unsafe files
      const stripped = toml.stripHookStanzas(text);
      if (stripped.removed + stripped.partial > 0) {
        agents.writeAtomic(configPath, stripped.text);
        unwired = stripped.removed + stripped.partial;
      }
      if (stripped.partial > 0) {
        warnings.push(
          'kimi — ' + stripped.partial + ' [[hooks]] stanza(s) in ' + userConfigPath() +
            ' mixed teamlore lines with your own keys: the teamlore lines were removed ' +
            'and your keys kept — review the file.'
        );
      }
      for (const stanza of stripped.manual) {
        warnings.push(
          'kimi — could not safely strip this [[hooks]] stanza in ' + userConfigPath() +
            ' — remove the teamlore lines manually:\n\n' + stanza
        );
      }
    } catch (err) {
      if (err && err.name === 'TomlUnsafeError') {
        err.message =
          'Could not safely edit ' + userConfigPath() + ' — remove this stanza manually:\n\n' +
          stanzaText() + '\n(' + err.message + ')';
      }
      throw err; // caller prints manual instructions; file left untouched
    }
  }
  if (unwired > 0) changed = true;
  rows.push({
    changed: unwired > 0,
    label: 'hooks',
    filePath: '~/.kimi-code/config.toml',
    note: unwired > 0 ? green('unwired') : dim('none wired'),
  });

  return { rows, warnings, changed };
}

module.exports = {
  id: 'kimi',
  label: 'Kimi Code',
  detect,
  globallyWired,
  install,
  uninstall,
  stanzaText,
  globalPaths: ['~/.kimi-code/config.toml', '~/.kimi-code/skills/teamlore/'],
};
