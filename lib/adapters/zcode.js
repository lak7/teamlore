'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const agents = require('../agents');
const ui = require('../ui');
const { commandExists, stripSettingsObject } = require('../merge-settings');
const {
  ZCODE_SKILL_DIR,
  ZCODE_SENTINEL_FILE,
  ZCODE_CONFIG_FILE,
  HOOK_MARKER,
} = require('../constants');

/*
 * ZCode adapter.
 *
 * Project hooks are NOT executed by ZCode (CONFIRMED) → hooks live in the
 * user-level ~/.zcode/cli/config.json and commands are absolute with forward
 * slashes, pointing at the machine-global skill copy (user consent required).
 * The project skill copy (.zcode/skills/teamlore) serves skill discovery and
 * the sentinel home. Scripts take `--host zcode` (frozen A2 contract).
 */

function detect(root) {
  return (
    fs.existsSync(path.join(root, '.zcode')) || fs.existsSync(path.join(root, 'zcode.json'))
  );
}

function userConfigPath() {
  return path.join(os.homedir(), ZCODE_CONFIG_FILE);
}

// True when the user-level config already carries teamlore hook commands.
function globallyWired() {
  try {
    return fs.readFileSync(userConfigPath(), 'utf8').includes(HOOK_MARKER);
  } catch (_) {
    return false;
  }
}

function userSkillDir() {
  return path.join(os.homedir(), '.zcode', 'skills', 'teamlore');
}

function command(script, mode) {
  const dir = userSkillDir().split(path.sep).join('/');
  return 'node "' + dir + '/scripts/' + script + '"' + (mode ? ' ' + mode : '') + ' --host zcode';
}

const ZCODE_EVENTS = {
  SessionStart: command('recall.js', 'session'),
  UserPromptSubmit: command('recall.js', 'prompt'),
  Stop: command('distill-check.js'),
};

// A "hooks" value the user put in the config that teamlore cannot merge with
// (string profile name, number, array, …). Absent and null count as "not
// set"; everything else that is not a plain object is refused — never
// silently replaced.
function isNonObjectHooks(config) {
  return (
    config.hooks !== undefined &&
    config.hooks !== null &&
    (typeof config.hooks !== 'object' || Array.isArray(config.hooks))
  );
}

// Merge teamlore hooks into a parsed config doc. Unknown keys (mcp.servers,
// plugin state, …) are preserved; `hooks.enabled` is set to true only when
// absent — never flipped, never removed.
function mergeZcodeConfig(config) {
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {};
  const hooks = config.hooks;
  let enabledWarning = false;
  if (hooks.enabled === undefined) hooks.enabled = true;
  else if (hooks.enabled !== true) enabledWarning = true;
  if (!hooks.events || typeof hooks.events !== 'object') hooks.events = {};

  const added = [];
  for (const [event, cmd] of Object.entries(ZCODE_EVENTS)) {
    const events = { hooks: hooks.events };
    if (commandExists(events, cmd)) continue;
    if (!Array.isArray(hooks.events[event])) hooks.events[event] = [];
    const block = {};
    if (event === 'SessionStart') block.matcher = 'startup|resume|clear|compact';
    block.hooks = [{ type: 'command', command: cmd }];
    hooks.events[event].push(block);
    added.push(event);
  }
  return { changed: added.length > 0, added, enabledWarning };
}

function mergeZcodeConfigText(existingText) {
  let config = {};
  if (existingText && existingText.trim()) {
    try {
      config = JSON.parse(existingText);
    } catch (err) {
      throw new Error(
        'Could not parse existing ' + userConfigPath() + ' as JSON — refusing to ' +
          'overwrite it. Fix or remove the file and re-run. (' + err.message + ')'
      );
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(userConfigPath() + ' is not a JSON object — refusing to overwrite it.');
    }
    if (isNonObjectHooks(config)) {
      // N1b: a non-object hooks value (e.g. "profile-a") carries user data we
      // cannot merge into — refuse instead of replacing it with our object.
      throw new Error(
        userConfigPath() + ' has a "hooks" value that is not a JSON object (' +
          JSON.stringify(config.hooks) + ') — refusing to modify it. Fix or remove the ' +
          '"hooks" key manually and re-run.'
      );
    }
  }
  const { changed, added, enabledWarning } = mergeZcodeConfig(config);
  return { changed, added, enabledWarning, text: JSON.stringify(config, null, 2) + '\n' };
}

// Reverse merge: strip only commands executing a teamlore script; `enabled`
// is left untouched. A non-object hooks value is refused (file left intact).
function stripZcodeConfigText(existingText) {
  let config;
  try {
    config = JSON.parse(existingText);
  } catch (err) {
    throw new Error(
      'Could not parse ' + userConfigPath() + ' as JSON — leaving it untouched. (' +
        err.message + ')'
    );
  }
  if (isNonObjectHooks(config)) {
    throw new Error(
      userConfigPath() + ' has a "hooks" value that is not a JSON object (' +
        JSON.stringify(config.hooks) + ') — leaving it untouched. Fix or remove the ' +
        '"hooks" key manually.'
    );
  }
  let removed = [];
  if (
    config && config.hooks && typeof config.hooks === 'object' &&
    config.hooks.events && typeof config.hooks.events === 'object'
  ) {
    const tmp = { hooks: config.hooks.events };
    const res = stripSettingsObject(tmp);
    removed = res.removed;
    if (Object.keys(tmp.hooks || {}).length === 0) delete config.hooks.events;
    else config.hooks.events = tmp.hooks;
  }
  return { changed: removed.length > 0, removed, text: JSON.stringify(config, null, 2) + '\n' };
}

function install(root, ctx) {
  const rows = [];
  const warnings = [];
  const { cyan, dim } = ui;
  let changed = false;

  // Project: skill copy + sentinel gitignore line.
  const skillRow = agents.skillRow(
    agents.copySkill(path.join(root, ZCODE_SKILL_DIR), ctx.templatesDir, ZCODE_SKILL_DIR),
    'skill',
    ZCODE_SKILL_DIR + '/'
  );
  if (skillRow.changed) changed = true;
  rows.push(skillRow);
  if (agents.ensureGitignoreLine(path.join(root, '.gitignore'), ZCODE_SENTINEL_FILE)) {
    changed = true;
  }

  // Machine-global (explicit --agents consent only).
  if (ctx.globalConsent) {
    const userSkillRow = agents.skillRow(
      agents.copySkill(userSkillDir(), ctx.templatesDir, ZCODE_SKILL_DIR),
      'skill',
      '~/.zcode/skills/teamlore/'
    );
    if (userSkillRow.changed) changed = true;
    rows.push(userSkillRow);

    const configPath = userConfigPath();
    agents.ensureDir(path.dirname(configPath));
    let existing = '';
    try {
      existing = fs.readFileSync(configPath, 'utf8');
    } catch (_) {
      existing = '';
    }
    const merged = mergeZcodeConfigText(existing);
    if (merged.changed) {
      agents.writeAtomic(configPath, merged.text);
      changed = true;
    }
    if (merged.enabledWarning) {
      warnings.push(
        'zcode — hooks.enabled is not true in ' + userConfigPath() +
          '; ZCode will not run teamlore hooks until you enable it.'
      );
    }
    rows.push({
      changed: merged.changed,
      label: 'hooks',
      filePath: '~/.zcode/cli/config.json',
      note: merged.changed ? cyan(merged.added.join(' ' + ui.symbols.dot + ' ')) : dim('already wired'),
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
  const skillRemoved = agents.rmrf(path.join(root, ZCODE_SKILL_DIR));
  if (skillRemoved) changed = true;
  rows.push({
    changed: skillRemoved,
    label: 'skill',
    filePath: ZCODE_SKILL_DIR + '/',
    note: skillRemoved ? green('removed') : dim('not present'),
  });
  if (agents.cleanGitignoreLines(path.join(root, '.gitignore'), [ZCODE_SENTINEL_FILE])) {
    changed = true;
  }

  // Machine-global (marker-scoped; enabled is never flipped to false).
  const userSkillRemoved = agents.rmrf(userSkillDir());
  if (userSkillRemoved) changed = true;
  rows.push({
    changed: userSkillRemoved,
    label: 'skill',
    filePath: '~/.zcode/skills/teamlore/',
    note: userSkillRemoved ? green('removed') : dim('not present'),
  });

  const configPath = userConfigPath();
  let hooksRemoved = { changed: false };
  if (fs.existsSync(configPath)) {
    const stripped = stripZcodeConfigText(fs.readFileSync(configPath, 'utf8'));
    hooksRemoved = stripped;
    if (stripped.changed) agents.writeAtomic(configPath, stripped.text);
  }
  if (hooksRemoved.changed) changed = true;
  rows.push({
    changed: hooksRemoved.changed,
    label: 'hooks',
    filePath: '~/.zcode/cli/config.json',
    note: hooksRemoved.changed
      ? green('unwired ') + dim(hooksRemoved.removed.join(' ' + ui.symbols.dot + ' '))
      : dim('none wired'),
  });

  return { rows, warnings, changed };
}

module.exports = {
  id: 'zcode',
  label: 'ZCode',
  detect,
  globallyWired,
  install,
  uninstall,
  mergeZcodeConfig,
  mergeZcodeConfigText,
  stripZcodeConfigText,
  globalPaths: ['~/.zcode/cli/config.json', '~/.zcode/skills/teamlore/'],
};
