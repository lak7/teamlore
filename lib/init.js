'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { applyToFile } = require('./merge-settings');
const ui = require('./ui');
const {
  SKILL_DIR,
  SETTINGS_FILE,
  LORE_DIR,
  LOREIGNORE_FILE,
  SENTINEL_FILE,
} = require('./constants');

const TEMPLATES = path.join(__dirname, '..', 'templates');

function version() {
  try {
    return require('../package.json').version;
  } catch (_) {
    return '';
  }
}

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

// Column geometry for the status rows.
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

function run(targetDir) {
  const root = targetDir || process.cwd();
  const out = (msg) => process.stdout.write(msg + '\n');
  const { green, dim, amber, cyan, bold, italic, symbols, rule } = ui;
  let changed = false;

  out(ui.banner(version()));

  const inGit = isGitRepo(root);
  if (!inGit) {
    out(
      '  ' +
        amber('!') +
        '  ' +
        dim('Not a git repo — teamlore uses git for sync, review, and the ') +
        dim('by') +
        dim('/') +
        dim('commit') +
        dim(' fields.')
    );
    out('     ' + dim('Run ') + cyan('git init') + dim(' for the full experience.'));
    out('');
  }

  // 1. Skill + hook scripts (kept up to date on re-run).
  const skillStats = {};
  copyTree(path.join(TEMPLATES, 'skill'), path.join(root, SKILL_DIR), true, skillStats);
  const created = skillStats.created || 0;
  const updated = skillStats.updated || 0;
  const skillTouched = created + updated;
  if (skillTouched) changed = true;
  renderRow(
    out,
    skillTouched > 0,
    'skill',
    SKILL_DIR + '/',
    created ? green(`${created} files`) : updated ? green(`${updated} updated`) : dim('up to date')
  );

  // 2. .lore/ + README stub (never overwrite; it holds real memories).
  ensureDir(path.join(root, LORE_DIR));
  const readmeStatus = writeIfChanged(
    path.join(root, LORE_DIR, 'README.md'),
    fs.readFileSync(path.join(TEMPLATES, 'lore-README.md'), 'utf8'),
    { overwrite: false }
  );
  if (readmeStatus === 'created') changed = true;
  renderRow(out, readmeStatus === 'created', 'brain', LORE_DIR + '/',
    readmeStatus === 'created' ? green('created') : dim('ready'));

  // 3. .loreignore (never overwrite user edits).
  const ignoreStatus = writeIfChanged(
    path.join(root, LOREIGNORE_FILE),
    fs.readFileSync(path.join(TEMPLATES, 'loreignore'), 'utf8'),
    { overwrite: false }
  );
  if (ignoreStatus === 'created') changed = true;
  renderRow(out, ignoreStatus === 'created', 'ignore', LOREIGNORE_FILE,
    ignoreStatus === 'created' ? green('created') : dim('exists'));

  // 4. Hooks — safe merge into settings.json.
  ensureDir(path.join(root, '.claude'));
  const { changed: hooksChanged, added } = applyToFile(path.join(root, SETTINGS_FILE));
  if (hooksChanged) changed = true;
  renderRow(out, hooksChanged, 'hooks', SETTINGS_FILE,
    hooksChanged ? cyan(added.join(' ' + symbols.dot + ' ')) : dim('already wired'));

  // 5. Keep the per-session sentinel out of git.
  if (ensureGitignoreLine(path.join(root, '.gitignore'), SENTINEL_FILE)) changed = true;

  out('');
  out('  ' + rule(RULE_W));
  out('');

  if (!changed) {
    out('  ' + symbols.ok + '  ' + bold('All set.') + '  ' + dim('teamlore is already installed here.'));
    out('');
    out('  ' + symbols.spark + '  ' + italic(dim('break things only once.')));
    out('');
    return 0;
  }

  out('  ' + bold('The brain is empty — for now.'));
  out('    ' + dim('Work normally. When Claude gets corrected, breaks something,'));
  out('    ' + dim('or hears a "why", it proposes lore. You review. You merge.'));
  out('');
  out('  ' + bold('Next steps'));
  out('    ' + amber('1') + '  ' + ui.padEnd('Review the changes', 22) + cyan('git status'));
  out('    ' + amber('2') + '  ' + ui.padEnd('Commit them', 22) + dim('teammates onboard with ') + cyan('git pull'));
  out('');
  out('  ' + symbols.spark + '  ' + italic(dim('lore is code — review it. break things only once.')));
  out('');
  return 0;
}

module.exports = { run };
