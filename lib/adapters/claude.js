'use strict';

const fs = require('fs');
const path = require('path');
const agents = require('../agents');
const ui = require('../ui');
const { applyToFile, stripFromFile } = require('../merge-settings');
const { SKILL_DIR, SETTINGS_FILE, SENTINEL_FILE } = require('../constants');

/*
 * Claude Code adapter — the v0.2.3 behavior, re-expressed as an adapter.
 * Bodies are moved verbatim from lib/init.js / lib/remove.js (skill copy,
 * settings.json hooks merge, sentinel gitignore line) — artifacts stay
 * byte-identical to v0.2.3.
 */

function detect(root) {
  return fs.existsSync(path.join(root, '.claude'));
}

function install(root, ctx) {
  const rows = [];
  const { green, cyan, dim } = ui;
  let changed = false;

  // 1. Skill + hook scripts (kept up to date on re-run).
  const stats = agents.copySkill(path.join(root, SKILL_DIR), ctx.templatesDir, SKILL_DIR);
  const skillRow = agents.skillRow(stats, 'skill', SKILL_DIR + '/');
  if (skillRow.changed) changed = true;
  rows.push(skillRow);

  // 2. Hooks — safe merge into settings.json.
  const { changed: hooksChanged, added } = applyToFile(path.join(root, SETTINGS_FILE));
  if (hooksChanged) changed = true;
  rows.push({
    changed: hooksChanged,
    label: 'hooks',
    filePath: SETTINGS_FILE,
    note: hooksChanged ? cyan(added.join(' ' + ui.symbols.dot + ' ')) : dim('already wired'),
  });

  // 3. Keep the per-session sentinel out of git.
  if (agents.ensureGitignoreLine(path.join(root, '.gitignore'), SENTINEL_FILE)) changed = true;

  return { rows, warnings: [], changed };
}

function uninstall(root) {
  const rows = [];
  const { green, dim } = ui;
  let changed = false;

  // 1. Skill + hook scripts.
  const skillRemoved = agents.rmrf(path.join(root, SKILL_DIR));
  if (skillRemoved) changed = true;
  rows.push({
    changed: skillRemoved,
    label: 'skill',
    filePath: SKILL_DIR + '/',
    note: skillRemoved ? green('removed') : dim('not present'),
  });

  // 2. Unwire hooks from settings.json (throws on unparseable — caller decides).
  const hooksRemoved = stripFromFile(path.join(root, SETTINGS_FILE));
  if (hooksRemoved.changed) changed = true;
  rows.push({
    changed: hooksRemoved.changed,
    label: 'hooks',
    filePath: SETTINGS_FILE,
    note: hooksRemoved.changed
      ? green('unwired ') + dim(hooksRemoved.removed.join(' ' + ui.symbols.dot + ' '))
      : dim('none wired'),
  });

  // 3. Clean the leftover sentinel + .gitignore entry.
  agents.rmrf(path.join(root, SENTINEL_FILE));
  if (agents.cleanGitignoreLines(path.join(root, '.gitignore'), [SENTINEL_FILE])) changed = true;

  return { rows, warnings: [], changed };
}

module.exports = {
  id: 'claude',
  label: 'Claude Code',
  detect,
  install,
  uninstall,
};
