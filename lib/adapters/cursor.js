'use strict';

const fs = require('fs');
const path = require('path');
const agents = require('../agents');
const ui = require('../ui');
const { isTeamloreScriptCommand, CURSOR_HOOKS_FILE, CURSOR_RULE_FILE } = require('../constants');

/*
 * Cursor adapter: .cursor/hooks.json merge/strip + .cursor/rules/teamlore.mdc.
 *
 * Cursor runs project hooks from the project root (CONFIRMED) → root-relative
 * commands. Scripts take `--host cursor` (frozen A2 script contract). Cursor
 * reads .claude/skills natively (CONFIRMED) → the shared claude-family skill
 * copy is ensured, never duplicated. UserPromptSubmit is NOT wired: Cursor's
 * beforeSubmitPrompt has no context-injection channel (CONFIRMED).
 */

const CURSOR_HOOKS = {
  sessionStart: 'node ".claude/skills/teamlore/scripts/recall.js" session --host cursor',
  stop: 'node ".claude/skills/teamlore/scripts/distill-check.js" --host cursor',
};

const RULE_MARKER = 'Teamlore shared team memory';

// Appendix A — .cursor/rules/teamlore.mdc (alwaysApply).
const RULE_CONTENT =
  '---\n' +
  'description: Teamlore shared team memory — consult .lore/ before tasks and after lessons.\n' +
  'alwaysApply: true\n' +
  '---\n' +
  'This project uses teamlore: `.lore/` holds small, reviewable team memories (one lesson per file).\n' +
  '- Check `.lore/` for entries whose `paths` globs match the files you are about to edit; follow and cite them.\n' +
  '- When corrected, after a surprising failure, or on a decision-with-a-why: propose `.lore/YYYY-MM-DD-slug.md`\n' +
  '  (≤120 words; frontmatter paths/kind/by/commit/verify_by), `git add` it, never commit.\n';

function detect(root) {
  return fs.existsSync(path.join(root, '.cursor'));
}

function commandExists(doc, command) {
  for (const event of Object.keys(doc.hooks || {})) {
    const blocks = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];
    if (blocks.some((b) => b && b.command === command)) return true;
  }
  return false;
}

// Merge teamlore commands into a parsed hooks.json doc (marker-safe dedupe;
// every unrelated hook is preserved).
function mergeCursorHooks(doc) {
  if (!doc.version) doc.version = 1;
  if (!doc.hooks || typeof doc.hooks !== 'object') doc.hooks = {};
  const added = [];
  for (const [event, command] of Object.entries(CURSOR_HOOKS)) {
    if (commandExists(doc, command)) continue;
    if (!Array.isArray(doc.hooks[event])) doc.hooks[event] = [];
    doc.hooks[event].push({ command });
    added.push(event);
  }
  return { changed: added.length > 0, added };
}

function mergeCursorHooksText(existingText) {
  let doc = {};
  if (existingText && existingText.trim()) {
    try {
      doc = JSON.parse(existingText);
    } catch (err) {
      throw new Error(
        'Could not parse existing ' + CURSOR_HOOKS_FILE + ' as JSON — refusing to ' +
          'overwrite it. Fix or remove the file and re-run. (' + err.message + ')'
      );
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error(CURSOR_HOOKS_FILE + ' is not a JSON object — refusing to overwrite it.');
    }
  }
  const { changed, added } = mergeCursorHooks(doc);
  return { changed, added, text: JSON.stringify(doc, null, 2) + '\n' };
}

// Strip every teamlore command (anchored-script ownership: only commands
// executing skills/teamlore/scripts/(recall|distill-check).js), collapsing
// empty event arrays. `removable` marks a doc that — after a strip that
// actually removed teamlore entries — holds nothing but the `version`
// scaffold teamlore added, i.e. the file only existed for teamlore and should
// be deleted instead of left behind. A file whose hooks merely mention the
// scripts path is never modified, hence never removable.
function stripCursorHooksText(existingText) {
  let doc;
  try {
    doc = JSON.parse(existingText);
  } catch (err) {
    throw new Error(
      'Could not parse ' + CURSOR_HOOKS_FILE + ' as JSON — leaving it untouched. (' +
        err.message + ')'
    );
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(CURSOR_HOOKS_FILE + ' is not a JSON object — leaving it untouched.');
  }
  let changed = false;
  for (const event of Object.keys(doc.hooks || {})) {
    const blocks = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];
    const kept = blocks.filter((b) => !isTeamloreScriptCommand(b && b.command));
    if (kept.length !== blocks.length) changed = true;
    if (kept.length > 0) doc.hooks[event] = kept;
    else delete doc.hooks[event];
  }
  if (doc.hooks && Object.keys(doc.hooks).length === 0) delete doc.hooks;
  const removable =
    changed && Object.keys(doc).length === 1 && doc.version === 1;
  return { changed, text: JSON.stringify(doc, null, 2) + '\n', removable };
}

function install(root, ctx) {
  const rows = [];
  const warnings = [];
  const { cyan, dim, green } = ui;
  let changed = false;

  // Shared claude-family skill copy (only reported when actually copied —
  // `--agents all` already installs it via the claude adapter).
  const stats = agents.ensureClaudeSkillCopy(root, ctx.templatesDir);
  if ((stats.created || 0) + (stats.updated || 0) > 0) {
    const row = agents.skillRow(stats, 'skill', '.claude/skills/teamlore/');
    if (row.changed) changed = true;
    rows.push(row);
  }

  // hooks.json — merge marker-safe (unrelated hooks preserved byte-exact).
  const hooksPath = path.join(root, CURSOR_HOOKS_FILE);
  let existing = '';
  try {
    existing = fs.readFileSync(hooksPath, 'utf8');
  } catch (_) {
    existing = '';
  }
  const merged = mergeCursorHooksText(existing);
  if (merged.changed) {
    agents.writeAtomic(hooksPath, merged.text);
    changed = true;
  }
  rows.push({
    changed: merged.changed,
    label: 'hooks',
    filePath: CURSOR_HOOKS_FILE,
    note: merged.changed ? cyan(merged.added.join(' ' + ui.symbols.dot + ' ')) : dim('already wired'),
  });

  // Always-apply rule (covers cloud agents where sessionStart does not run).
  const ruleStatus = agents.writeIfChanged(path.join(root, CURSOR_RULE_FILE), RULE_CONTENT, {
    overwrite: true,
  });
  if (ruleStatus === 'created' || ruleStatus === 'updated') changed = true;
  rows.push({
    changed: ruleStatus === 'created' || ruleStatus === 'updated',
    label: 'rules',
    filePath: CURSOR_RULE_FILE,
    note:
      ruleStatus === 'created' ? green('created')
        : ruleStatus === 'updated' ? green('updated')
        : dim('up to date'),
  });

  return { rows, warnings, changed };
}

function uninstall(root) {
  const rows = [];
  const warnings = [];
  const { green, dim } = ui;
  let changed = false;

  const hooksPath = path.join(root, CURSOR_HOOKS_FILE);
  let hooksRemoved = { changed: false };
  if (fs.existsSync(hooksPath)) {
    const stripped = stripCursorHooksText(fs.readFileSync(hooksPath, 'utf8'));
    hooksRemoved = stripped;
    if (stripped.removable) agents.rmrf(hooksPath); // teamlore created it; now empty
    else if (stripped.changed) agents.writeAtomic(hooksPath, stripped.text);
  }
  if (hooksRemoved.changed) changed = true;
  rows.push({
    changed: hooksRemoved.changed,
    label: 'hooks',
    filePath: CURSOR_HOOKS_FILE,
    note: hooksRemoved.changed ? green('unwired') : dim('none wired'),
  });

  const rulePath = path.join(root, CURSOR_RULE_FILE);
  let ruleContent = '';
  try {
    ruleContent = fs.readFileSync(rulePath, 'utf8');
  } catch (_) {
    ruleContent = '';
  }
  const ruleRemoved = ruleContent.includes(RULE_MARKER);
  if (ruleRemoved) {
    agents.rmrf(rulePath);
    changed = true;
  }
  rows.push({
    changed: ruleRemoved,
    label: 'rules',
    filePath: CURSOR_RULE_FILE,
    note: ruleRemoved ? green('removed') : dim('not present'),
  });

  return { rows, warnings, changed };
}

module.exports = {
  id: 'cursor',
  label: 'Cursor',
  detect,
  install,
  uninstall,
  mergeCursorHooks,
  mergeCursorHooksText,
  stripCursorHooksText,
  RULE_CONTENT,
};
