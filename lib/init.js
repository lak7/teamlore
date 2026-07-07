'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { applyToFile } = require('./merge-settings');
const {
  SKILL_DIR,
  SETTINGS_FILE,
  LORE_DIR,
  LOREIGNORE_FILE,
  SENTINEL_FILE,
} = require('./constants');

const TEMPLATES = path.join(__dirname, '..', 'templates');

function isGitRepo(dir) {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch (_) {
    return false;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Returns 'created' | 'updated' | 'unchanged' | 'skipped'
function writeIfChanged(dest, content, { overwrite }) {
  const exists = fs.existsSync(dest);
  if (exists && !overwrite) return 'skipped';
  if (exists) {
    if (fs.readFileSync(dest, 'utf8') === content) return 'unchanged';
    fs.writeFileSync(dest, content);
    return 'updated';
  }
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, content);
  return 'created';
}

// Recursively copy a template dir; returns aggregate status counts.
function copyTree(srcDir, destDir, overwrite, stats) {
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    if (fs.statSync(src).isDirectory()) {
      ensureDir(dest);
      copyTree(src, dest, overwrite, stats);
    } else {
      const status = writeIfChanged(dest, fs.readFileSync(src, 'utf8'), { overwrite });
      stats[status] = (stats[status] || 0) + 1;
    }
  }
}

function ensureGitignoreLine(gitignorePath, line) {
  let content = '';
  try {
    content = fs.readFileSync(gitignorePath, 'utf8');
  } catch (_) {
    content = '';
  }
  const lines = content.split('\n').map((l) => l.trim());
  if (lines.includes(line)) return false;
  const prefix = content && !content.endsWith('\n') ? '\n' : '';
  const header = content.includes('# teamlore') ? '' : '\n# teamlore\n';
  fs.appendFileSync(gitignorePath, prefix + header + line + '\n');
  return true;
}

function run(targetDir) {
  const root = targetDir || process.cwd();
  const log = (msg) => process.stdout.write(msg + '\n');
  let changed = false;

  log('teamlore init — shared memory for your team\'s agents\n');

  const inGit = isGitRepo(root);
  if (!inGit) {
    log('  !  Not a git repository. teamlore relies on git for sync, review,');
    log('     and the `by`/`commit` fields. Run `git init` for the full experience.\n');
  }

  // 1. Skill + hook scripts (kept up to date on re-run).
  const skillStats = {};
  copyTree(path.join(TEMPLATES, 'skill'), path.join(root, SKILL_DIR), true, skillStats);
  const skillTouched = (skillStats.created || 0) + (skillStats.updated || 0);
  if (skillTouched) changed = true;
  log(
    `  ${skillTouched ? '✓' : '·'} skill      ${SKILL_DIR}/` +
      (skillStats.created ? `  (${skillStats.created} new)` : '') +
      (skillStats.updated ? `  (${skillStats.updated} updated)` : '') +
      (!skillTouched ? '  (up to date)' : '')
  );

  // 2. .lore/ + README stub (never overwrite; it holds real memories).
  ensureDir(path.join(root, LORE_DIR));
  const readmeStatus = writeIfChanged(
    path.join(root, LORE_DIR, 'README.md'),
    fs.readFileSync(path.join(TEMPLATES, 'lore-README.md'), 'utf8'),
    { overwrite: false }
  );
  if (readmeStatus === 'created') changed = true;
  log(`  ${readmeStatus === 'created' ? '✓' : '·'} brain      ${LORE_DIR}/` +
    (readmeStatus === 'created' ? '  (created)' : '  (exists)'));

  // 3. .loreignore (never overwrite user edits).
  const ignoreStatus = writeIfChanged(
    path.join(root, LOREIGNORE_FILE),
    fs.readFileSync(path.join(TEMPLATES, 'loreignore'), 'utf8'),
    { overwrite: false }
  );
  if (ignoreStatus === 'created') changed = true;
  log(`  ${ignoreStatus === 'created' ? '✓' : '·'} ignore     ${LOREIGNORE_FILE}` +
    (ignoreStatus === 'created' ? '  (created)' : '  (exists)'));

  // 4. Hooks — safe merge into settings.json.
  ensureDir(path.join(root, '.claude'));
  const { changed: hooksChanged, added } = applyToFile(path.join(root, SETTINGS_FILE));
  if (hooksChanged) changed = true;
  log(`  ${hooksChanged ? '✓' : '·'} hooks      ${SETTINGS_FILE}` +
    (hooksChanged ? `  (wired ${added.join(', ')})` : '  (already wired)'));

  // 5. Keep the per-session sentinel out of git.
  const gi = ensureGitignoreLine(path.join(root, '.gitignore'), SENTINEL_FILE);
  if (gi) changed = true;

  log('');
  if (!changed) {
    log('Already installed — nothing to do. teamlore is ready.\n');
    return 0;
  }

  log('Done. Next steps:');
  log('  1. Review the changes:  git status  (lore is code — treat it that way)');
  log('  2. Commit them so teammates get teamlore on their next `git pull`.');
  log('  3. Just keep coding. Lore gets proposed when you correct the agent,');
  log('     something breaks, or a decision gets made — and recalled automatically.');
  log('');
  return 0;
}

module.exports = { run };
