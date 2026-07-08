'use strict';

const fs = require('fs');
const path = require('path');
const { stripFromFile } = require('./merge-settings');
const ui = require('./ui');
const {
  SKILL_DIR,
  SETTINGS_FILE,
  LORE_DIR,
  LOREIGNORE_FILE,
  SENTINEL_FILE,
} = require('./constants');

function version() {
  try {
    return require('../package.json').version;
  } catch (_) {
    return '';
  }
}

const LABEL_W = 6;
const PATH_W = 26;
const RULE_W = 48;

function renderRow(out, changed, label, filePath, note) {
  const { symbols, cyan, dim, padEnd } = ui;
  const sym = changed ? symbols.ok : symbols.skip;
  const labelCell = (changed ? cyan : dim)(padEnd(label, LABEL_W));
  const pathCell = dim(padEnd(filePath, PATH_W));
  out(`  ${sym}  ${labelCell}  ${pathCell}  ${note}`);
}

// Remove the sentinel line (and the teamlore comment we added) from .gitignore,
// leaving all other entries intact.
function cleanGitignore(gitignorePath) {
  let content;
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch (_) {
    return false;
  }
  const lines = content.split('\n');
  const kept = lines.filter(
    (l) => l.trim() !== SENTINEL_FILE && l.trim() !== '# teamlore'
  );
  if (kept.length === lines.length) return false;
  // drop a trailing run of blank lines we may have introduced, keep one newline
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  fs.writeFileSync(gitignorePath, text);
  return true;
}

function rmrf(target) {
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

function run(targetDir, opts) {
  const root = targetDir || process.cwd();
  const purge = !!(opts && opts.purge);
  const out = (msg) => process.stdout.write(msg + '\n');
  const { green, dim, amber, symbols, rule, bold, italic, cyan } = ui;
  let changed = false;

  out(ui.banner(version()));

  // 1. Skill + hook scripts.
  const skillRemoved = rmrf(path.join(root, SKILL_DIR));
  if (skillRemoved) changed = true;
  renderRow(out, skillRemoved, 'skill', SKILL_DIR + '/',
    skillRemoved ? green('removed') : dim('not present'));

  // 2. Unwire hooks from settings.json.
  let hooksRemoved = { changed: false, removed: [] };
  try {
    hooksRemoved = stripFromFile(path.join(root, SETTINGS_FILE));
  } catch (err) {
    out('  ' + amber('!') + '  ' + dim(err.message));
  }
  if (hooksRemoved.changed) changed = true;
  renderRow(out, hooksRemoved.changed, 'hooks', SETTINGS_FILE,
    hooksRemoved.changed
      ? green('unwired ') + dim(hooksRemoved.removed.join(' ' + symbols.dot + ' '))
      : dim('none wired'));

  // 3. Clean the leftover sentinel + .gitignore entry.
  rmrf(path.join(root, SENTINEL_FILE));
  const giCleaned = cleanGitignore(path.join(root, '.gitignore'));
  if (giCleaned) changed = true;

  // 4. The brain — kept by default (it holds your team's real memories).
  const loreExists = fs.existsSync(path.join(root, LORE_DIR));
  if (purge) {
    const loreGone = rmrf(path.join(root, LORE_DIR));
    const ignGone = rmrf(path.join(root, LOREIGNORE_FILE));
    if (loreGone || ignGone) changed = true;
    renderRow(out, loreGone, 'brain', LORE_DIR + '/',
      loreGone ? amber('purged') : dim('not present'));
  } else if (loreExists) {
    renderRow(out, false, 'brain', LORE_DIR + '/',
      dim('kept — your memories (') + cyan('--purge') + dim(' to delete)'));
  }

  out('');
  out('  ' + rule(RULE_W));
  out('');

  if (!changed) {
    out('  ' + symbols.skip + '  ' + bold('Nothing to remove.') + '  ' + dim('teamlore is not installed here.'));
    out('');
    return 0;
  }

  out('  ' + symbols.ok + '  ' + bold('teamlore removed.') +
    (loreExists && !purge ? '  ' + dim('Your ') + cyan('.lore/') + dim(' memories are still here.') : ''));
  out('');
  out('  ' + symbols.spark + '  ' + italic(dim('thanks for breaking things only once.')));
  out('');
  return 0;
}

module.exports = { run };
