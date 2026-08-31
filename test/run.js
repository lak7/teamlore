'use strict';

/*
 * Test runner — executes every suite with plain node (no frameworks) and
 * exits non-zero if any suite fails. Run from the repo root: node test/run.js
 *
 * Suites are independent and individually runnable; this entry point only
 * sequences them, prints one summary line per suite, and fails as a whole
 * (single non-zero exit) if any suite fails.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Suites in execution order; a suite is skipped (and marked as such) when its
// file is absent, so the runner works while suites are still landing.
const SUITES = ['unit-merge.js', 'hooks-matrix.js', 'e2e.js', 'adversarial.js', 'adversarial2.js'];

const results = [];
for (const suite of SUITES) {
  const file = path.join(__dirname, suite);
  if (!fs.existsSync(file)) {
    results.push({ suite, missing: true });
    continue;
  }
  console.log('\n--- ' + suite + ' ' + '-'.repeat(Math.max(1, 50 - suite.length)));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  const ms = Date.now() - t0;
  results.push({ suite, ok: r.status === 0, status: r.status, ms });
  console.log('    [' + (r.status === 0 ? 'PASS' : 'FAIL') + '] ' + suite + ' (' + ms + ' ms)');
}

console.log('\n=== summary ===');
let failures = 0;
for (const res of results) {
  if (res.missing) {
    console.log('  [SKIP] ' + res.suite + ' (absent)');
  } else if (res.ok) {
    console.log('  [PASS] ' + res.suite + ' - ' + res.ms + ' ms');
  } else {
    failures++;
    console.log('  [FAIL] ' + res.suite + ' - exit ' + res.status);
  }
}

console.log('');
if (failures > 0) {
  console.log(failures + ' suite(s) FAILED');
  process.exitCode = 1;
} else {
  console.log('All suites passed.');
}
