'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ui = require('./ui');
const agents = require('./agents');
const { appendAgentsSection } = require('./agents-md');
const {
  LORE_DIR,
  LOREIGNORE_FILE,
  HOST_IDS,
  AGENTS_MD_FILE,
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
    agents.writeAtomic(dest, content);
    return 'updated';
  }
  ensureDir(path.dirname(dest));
  agents.writeAtomic(dest, content);
  return 'created';
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

// Print a refusal / warning message (multi-line manual instructions included).
function printWarning(out, message) {
  const lines = String(message).split('\n');
  out('  ' + ui.amber('!') + '  ' + ui.dim(lines[0]));
  for (const line of lines.slice(1)) out('     ' + line);
}

// Resolve the host selection from an explicit --agents value (§4.4):
// exactly the listed hosts, each with machine-global consent. Throws a
// styled, user-facing error listing the valid ids when unknown.
function parseAgentsList(value) {
  const ids = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ids.length) {
    throw new Error('--agents needs a host list (' + HOST_IDS.join(', ') + ', or all)');
  }
  const expanded = ids.includes('all') ? HOST_IDS : ids;
  for (const id of expanded) {
    if (!HOST_IDS.includes(id)) {
      throw new Error(
        'Unknown host "' + id + '". Valid hosts: ' + HOST_IDS.join(', ') + ' (or all).'
      );
    }
  }
  return expanded;
}

function run(targetDir, opts) {
  const root = targetDir || process.cwd();
  const out = (msg) => process.stdout.write(msg + '\n');
  const { green, dim, amber, cyan, bold, italic, symbols, rule } = ui;
  let changed = false;
  let failed = false;

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

  // Host selection (mission §4.4): bare init = claude always + project-level
  // parts of auto-detected non-claude hosts; --agents = exactly those hosts,
  // each with machine-global consent.
  const adapters = agents.loadAdapters();
  let selection;
  let explicit = false;
  if (opts && opts.agents !== undefined) {
    explicit = true;
    let ids;
    try {
      ids = parseAgentsList(opts.agents);
    } catch (err) {
      printWarning(out, err.message);
      out('');
      return 1;
    }
    selection = ids.map((id) => ({
      adapter: adapters.find((a) => a.id === id),
      globalConsent: true,
    }));
  } else {
    selection = [{ adapter: adapters.find((a) => a.id === 'claude'), globalConsent: false }];
    for (const adapter of adapters) {
      if (adapter.id !== 'claude' && adapter.detect(root)) {
        selection.push({ adapter, globalConsent: false });
      }
    }
  }

  // 1. .lore/ + README stub (never overwrite; it holds real memories).
  ensureDir(path.join(root, LORE_DIR));
  const readmeStatus = writeIfChanged(
    path.join(root, LORE_DIR, 'README.md'),
    fs.readFileSync(path.join(TEMPLATES, 'lore-README.md'), 'utf8'),
    { overwrite: false }
  );
  if (readmeStatus === 'created') changed = true;
  renderRow(out, readmeStatus === 'created', 'brain', LORE_DIR + '/',
    readmeStatus === 'created' ? green('created') : dim('ready'));

  // 2. .loreignore (never overwrite user edits).
  const ignoreStatus = writeIfChanged(
    path.join(root, LOREIGNORE_FILE),
    fs.readFileSync(path.join(TEMPLATES, 'loreignore'), 'utf8'),
    { overwrite: false }
  );
  if (ignoreStatus === 'created') changed = true;
  renderRow(out, ignoreStatus === 'created', 'ignore', LOREIGNORE_FILE,
    ignoreStatus === 'created' ? green('created') : dim('exists'));

  // 3. Per-host adapters (project artifacts; machine-global only with consent).
  for (const { adapter, globalConsent } of selection) {
    if (globalConsent && adapter.globalPaths) {
      for (const p of adapter.globalPaths) {
        out('  ' + amber('!') + '  ' + cyan(adapter.label) + dim(' — editing user-level ' + p));
      }
    }
    try {
      const res = adapter.install(root, { templatesDir: TEMPLATES, globalConsent });
      for (const row of res.rows) {
        renderRow(out, row.changed, row.label, row.filePath, row.note);
      }
      for (const w of res.warnings) printWarning(out, w);
      if (res.changed) changed = true;
    } catch (err) {
      // Refusal (unparseable config / unsafe TOML) — print it, keep going.
      failed = true;
      printWarning(out, err.message);
    }
  }

  // 4. AGENTS.md fallback — only when a non-claude host is selected.
  if (selection.some((s) => s.adapter.id !== 'claude')) {
    const agentsChanged = appendAgentsSection(root);
    if (agentsChanged) changed = true;
    renderRow(out, agentsChanged, 'agents', AGENTS_MD_FILE,
      agentsChanged ? green('added') : dim('ready'));
  }

  // 5. Detected hosts whose machine-global wiring still needs explicit
  //    consent get an instruction row (skipped when already wired).
  if (!explicit) {
    for (const { adapter, globalConsent } of selection) {
      if (adapter.globalPaths && !globalConsent &&
          !(adapter.globallyWired && adapter.globallyWired())) {
        out(
          '  ' + amber('!') + '  ' + cyan(adapter.label) + dim(' detected — wire its hooks: ') +
            cyan('npx teamlore init --agents ' + adapter.id) +
            dim(' (edits ' + adapter.globalPaths[0] + ')')
        );
      }
    }
  }

  out('');
  out('  ' + rule(RULE_W));
  out('');

  if (failed) {
    out('  ' + amber('!') + '  ' + bold('Finished with warnings') + '  ' + dim('see the ' + amber('!') + ' rows above.'));
    out('');
    return 1;
  }

  if (!changed) {
    out('  ' + symbols.ok + '  ' + bold('All set.') + '  ' + dim('teamlore is already installed here.'));
    out('');
    out('  ' + dim('   See the brain as a living scar map: ') + cyan('npx teamlore scarmap'));
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
  out('    ' + amber('3') + '  ' + ui.padEnd('See the scars', 22) + cyan('npx teamlore scarmap') + dim(' — a living map, once lore accumulates'));
  out('');
  out('  ' + symbols.spark + '  ' + italic(dim('lore is code — review it. break things only once.')));
  out('');
  return 0;
}

module.exports = { run, parseAgentsList };
