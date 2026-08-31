'use strict';

const fs = require('fs');
const path = require('path');
const ui = require('./ui');
const agents = require('./agents');
const { stripAgentsSection } = require('./agents-md');
const { LORE_DIR, LOREIGNORE_FILE } = require('./constants');

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

// Print a refusal / warning message (multi-line manual instructions included).
function printWarning(out, message) {
  const lines = String(message).split('\n');
  out('  ' + ui.amber('!') + '  ' + ui.dim(lines[0]));
  for (const line of lines.slice(1)) out('     ' + line);
}

function run(targetDir, opts) {
  const root = targetDir || process.cwd();
  const purge = !!(opts && opts.purge);
  const out = (msg) => process.stdout.write(msg + '\n');
  const { green, dim, amber, symbols, rule, bold, italic, cyan } = ui;
  let changed = false;

  out(ui.banner(version()));

  // 1. Unwind every host found — selection is ignored on remove (mission
  //    §4.4): project-level artifacts by marker scan, machine-global entries
  //    by HOOK_MARKER scan. Refusals print a warning and the loop continues,
  //    leaving the refused file untouched.
  for (const adapter of agents.loadAdapters()) {
    try {
      const res = adapter.uninstall(root);
      for (const row of res.rows) {
        renderRow(out, row.changed, row.label, row.filePath, row.note);
      }
      for (const w of res.warnings) printWarning(out, w);
      if (res.changed) changed = true;
    } catch (err) {
      printWarning(out, err.message);
    }
  }

  // 2. The marker-guarded AGENTS.md fallback section (any host may have added it).
  if (stripAgentsSection(root)) changed = true;

  // 3. The brain — kept by default (it holds your team's real memories).
  const loreExists = fs.existsSync(path.join(root, LORE_DIR));
  if (purge) {
    const loreGone = agents.rmrf(path.join(root, LORE_DIR));
    const ignGone = agents.rmrf(path.join(root, LOREIGNORE_FILE));
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
