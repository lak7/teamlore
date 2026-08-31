'use strict';

const fs = require('fs');
const path = require('path');
const agents = require('../agents');
const ui = require('../ui');
const { OPENCODE_PLUGIN_FILE } = require('../constants');

/*
 * OpenCode adapter: installs the in-process plugin (.opencode/plugins/
 * teamlore.js from templates/opencode/teamlore.js) and ensures the shared
 * claude-family skill copy exists — OpenCode reads .claude/skills natively
 * (CONFIRMED), so no second skill copy is ever made. The plugin delegates to
 * the committed node scripts; no config-file merge exists for OpenCode.
 */

const PLUGIN_MARKER = 'teamlore';

function detect(root) {
  return (
    fs.existsSync(path.join(root, '.opencode')) ||
    fs.existsSync(path.join(root, 'opencode.json')) ||
    fs.existsSync(path.join(root, 'opencode.jsonc'))
  );
}

function install(root, ctx) {
  const rows = [];
  const warnings = [];
  const { green, dim } = ui;
  let changed = false;

  // Shared claude-family skill copy (reported only when actually copied).
  const stats = agents.ensureClaudeSkillCopy(root, ctx.templatesDir);
  if ((stats.created || 0) + (stats.updated || 0) > 0) {
    const skillRow = agents.skillRow(stats, 'skill', '.claude/skills/teamlore/');
    if (skillRow.changed) changed = true;
    rows.push(skillRow);
  }

  // In-process plugin.
  const pluginPath = path.join(root, OPENCODE_PLUGIN_FILE);
  const templatePath = path.join(ctx.templatesDir, 'opencode', 'teamlore.js');
  if (fs.existsSync(templatePath)) {
    const status = agents.writeIfChanged(
      pluginPath,
      fs.readFileSync(templatePath, 'utf8'),
      { overwrite: true }
    );
    if (status === 'created' || status === 'updated') changed = true;
    rows.push({
      changed: status === 'created' || status === 'updated',
      label: 'plugin',
      filePath: OPENCODE_PLUGIN_FILE,
      note:
        status === 'created' ? green('created')
          : status === 'updated' ? green('updated')
          : dim('up to date'),
    });
  } else {
    warnings.push(
      'opencode — plugin template missing from this package; skipped (' +
        'templates/opencode/teamlore.js not found).'
    );
  }

  return { rows, warnings, changed };
}

function uninstall(root) {
  const rows = [];
  const { green, dim } = ui;
  let changed = false;

  const pluginPath = path.join(root, OPENCODE_PLUGIN_FILE);
  let content = '';
  try {
    content = fs.readFileSync(pluginPath, 'utf8');
  } catch (_) {
    content = '';
  }
  const pluginRemoved = !!content && content.includes(PLUGIN_MARKER);
  if (pluginRemoved) {
    agents.rmrf(pluginPath);
    changed = true;
  }
  rows.push({
    changed: pluginRemoved,
    label: 'plugin',
    filePath: OPENCODE_PLUGIN_FILE,
    note: pluginRemoved ? green('removed') : dim('not present'),
  });

  return { rows, warnings, changed };
}

module.exports = {
  id: 'opencode',
  label: 'OpenCode',
  detect,
  install,
  uninstall,
};
