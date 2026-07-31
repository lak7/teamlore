'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { collect } = require('./collector');
const { generateHTML } = require('./template');
const ui = require('../ui');

/**
 * Open a file in the user's default browser.
 * Silently fails — worst case the user opens it manually.
 */
function openInBrowser(filePath) {
  const cmd =
    process.platform === 'darwin'  ? 'open' :
    process.platform === 'win32'   ? 'start ""' :
    /* linux / others */             'xdg-open';
  try {
    execSync(cmd + ' ' + JSON.stringify(filePath), { stdio: 'ignore' });
  } catch (_) {
    // non-fatal — user can open the path printed to the terminal
  }
}

/**
 * Main entry point for `teamlore scarmap`.
 *
 * @param {string} targetDir  — repo root (default cwd)
 * @param {{ out?: string, root?: string }} [opts]
 *        root — explicit repo root to target (bypasses git-toplevel detection,
 *        so a gitignored fixture directory can be rendered on its own).
 * @returns {number} exit code
 */
function run(targetDir, opts) {
  const out = (msg) => process.stdout.write(msg + '\n');
  const { bold, dim, cyan, green, amber, symbols } = ui;

  // 1 ── collect the full scarmap payload
  const target = (opts && opts.root) || targetDir;
  const graphData = collect(target, { explicitRoot: !!(opts && opts.root) });
  const { lore, repoName, heat } = graphData;

  if (lore.length === 0) {
    out('');
    out('  ' + symbols.spark + '  ' + bold('No scars yet — that changes soon.'));
    out('     ' + dim('Lore accumulates as your team works: corrections, surprising'));
    out('     ' + dim('failures, decisions with a why. Each one becomes a scar here —'));
    out('     ' + dim('a living map of where the codebase bites.'));
    out('');
    out('     ' + dim('Not installed yet? ') + cyan('npx teamlore init'));
    out('');
    return 0;
  }

  // 2 ── generate HTML
  const html = generateHTML(graphData, repoName);

  // 4 ── write to temp dir (industry standard for CLI-generated viewable artifacts)
  const outDir = opts && opts.out
    ? path.resolve(opts.out)
    : path.join(os.tmpdir(), 'teamlore-scarmap');

  fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, 'scarmap.html');
  fs.writeFileSync(outFile, html);

  // 5 ── print summary + open
  const kinds = { mistake: 0, gotcha: 0, decision: 0 };
  lore.forEach((n) => { kinds[n.kind] = (kinds[n.kind] || 0) + 1; });

  // Hottest directory (highest normalized heat).
  let hottest = '';
  let hottestNorm = -1;
  for (const d in heat) {
    if (heat[d].norm > hottestNorm) { hottestNorm = heat[d].norm; hottest = d; }
  }
  const dirCount = Object.keys(heat).length;

  out('');
  out('  ' + symbols.spark + '  ' + bold('scarmap') + '  ' + dim(repoName));
  out('');
  out(
    '  ' + green(lore.length + ' scar' + (lore.length !== 1 ? 's' : '')) +
    dim('  (') +
    [
      kinds.mistake  ? amber(kinds.mistake  + ' mistake' + (kinds.mistake  !== 1 ? 's' : '')) : '',
      kinds.gotcha   ? cyan(kinds.gotcha    + ' gotcha'  + (kinds.gotcha   !== 1 ? 's' : '')) : '',
      kinds.decision ? dim(kinds.decision   + ' decision'+ (kinds.decision !== 1 ? 's' : '')) : '',
    ].filter(Boolean).join(dim(', ')) +
    dim(')')
  );
  if (hottest) {
    out('  ' + cyan(dirCount + ' scarred director' + (dirCount !== 1 ? 'ies' : 'y')) +
        dim('  · hottest: ') + amber(hottest));
  }
  out('');
  out('  ' + dim(outFile));
  out('');

  openInBrowser(outFile);
  return 0;
}

module.exports = { run };
