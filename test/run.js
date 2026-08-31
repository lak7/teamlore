'use strict';

/*
 * Test runner — executes every suite with plain node (no frameworks) and
 * exits non-zero if any suite fails. Run from the repo root: node test/run.js
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Suites in order; A2-owned suites are included when present so the runner
// works before/after they land.
const SUITES = ['unit-merge.js', 'hooks-matrix.js', 'e2e.js'];

let failures = 0;
for (const suite of SUITES) {
  const file = path.join(__dirname, suite);
  if (!fs.existsSync(file)) continue;
  console.log('\n--- ' + suite + ' ' + '-'.repeat(Math.max(1, 50 - suite.length)));
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (r.status !== 0) {
    failures++;
    console.log('*** ' + suite + ' FAILED (exit ' + r.status + ')');
  }
}

console.log('');
if (failures > 0) {
  console.log(failures + ' suite(s) FAILED');
  process.exitCode = 1;
} else {
  console.log('All suites passed.');
}
