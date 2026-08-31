'use strict';

/*
 * Adversarial pass 2 — Red Team agent A6 (merge-safety attack suite).
 * Plain node assert, no frameworks, zero deps, Windows-safe.
 * Run: node test/adversarial2.js
 *
 * Mission: break the merge-safety guarantees (master-mission §7, §9 R1/R2/R6).
 * Report-driven: every probe prints one of
 *   CONFIRMED-EXPLOIT [tag] — the guarantee is broken today (repro in this file)
 *   SAFE [tag]              — refused-or-preserved under the attack
 *   FINDING [tag]           — semantics preserved but bytes/UX diverge (data for triage)
 * Product code is NOT fixed here (lib/ out of scope). Assertions pin CURRENT
 * behavior (so the suite stays green); the printed verdicts are the report.
 *
 * Probe map (mission order):
 *   F1a/F1b  deepened — HOOK_MARKER substring strip (cursor file deletion + claude decoy)
 *   F2a/F2b  deepened — kimi whole-stanza strip (comments/user keys) + nested [[hooks.subtable]]
 *   F3a..F3f deepened — JSON re-serialization (CRLF, dup keys, key order, BOM, JSONC, deep nesting)
 *   F4a..F4c deepened — AGENTS.md strip (fenced code block, glued text, seam whitespace)
 *   N1a..N1f zcode config.json hostility (array, hooks-as-string/number, enabled:"true",
 *            relocated event, 2MB, ~/.zcode/cli as a FILE)
 *   N2a..N2e kimi TOML hostility (BOM, CP1256, interleaved stanzas, quote/%/unicode home,
 *            config.toml as a directory)
 *   N3a/N3b  atomic-write tmp hygiene (stray *.tmp-* after success; after rename failure)
 *   N4a..N4f hook scripts (10MB stdin, 1MB body, paths ["**"] cap, session_id traversal,
 *            sanitization collision, unknown --host)
 *   N5a..N5e CLI --agents parsing (flag twice, equals form, case, empty, empty element)
 *   N6       .lore/README.md written by the user is never overwritten
 *   N7       .gitignore blank-line collapse on remove
 *
 * Safety: every teamlore spawn runs with a fake home (USERPROFILE+HOME redirect)
 * so remove/init can never touch this machine's real user-level configs.
 * Telemetry off. State files land in os.tmpdir() with unique ids and are cleaned.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'teamlore.js');
const RECALL = path.join(REPO_ROOT, 'templates', 'skill', 'scripts', 'recall.js');
const DISTILL = path.join(REPO_ROOT, 'templates', 'skill', 'scripts', 'distill-check.js');

// ---- harness ---------------------------------------------------------------

const tmpRoots = [];
const stateFiles = [];
let passed = 0;
let failed = 0;
const verdicts = [];

function verdict(kind, tag, sev, msg) {
  verdicts.push({ kind, tag, sev, msg });
  console.log('  ' + kind + ' [' + tag + '] (P' + sev + '): ' + msg);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok - ' + name);
  } catch (err) {
    failed++;
    console.error('  FAIL - ' + name + '\n    ' + (err && err.message));
  }
}

// Read-only bits would block rmSync on Windows — clear them before removal.
function chmodWalk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (_) {
      continue;
    }
    if (st.isDirectory()) chmodWalk(p);
    else {
      try {
        fs.chmodSync(p, 0o666);
      } catch (_) { /* best effort */ }
    }
  }
  try {
    fs.chmodSync(dir, 0o777);
  } catch (_) { /* best effort */ }
}

function cleanup() {
  for (const f of stateFiles) {
    try { fs.unlinkSync(f); } catch (_) { /* best effort */ }
  }
  for (const dir of tmpRoots) {
    try { chmodWalk(dir); } catch (_) { /* best effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function gitInit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function readBuf(file) {
  return fs.readFileSync(file);
}

function sameBytes(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

const BASE_ENV = { ...process.env, TEAMLORE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
function fakeHomeEnv(fakeHome) {
  return { ...BASE_ENV, USERPROFILE: fakeHome, HOME: fakeHome };
}

// Spawn the real CLI. ALWAYS with a fake home: `remove` scans user-level
// configs on the real machine otherwise.
function teamlore(args, cwd, env) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: env || fakeHomeEnv(tmpDir('tl-a6-thrownaway-')),
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Spawn a hook script with a JSON payload on stdin.
function runScript(script, args, payload, opts) {
  const res = spawnSync(process.execPath, [script, ...args], {
    input: payload === undefined ? '' : JSON.stringify(payload),
    cwd: (opts && opts.cwd) || REPO_ROOT,
    env: (opts && opts.env) || BASE_ENV,
  });
  return {
    out: (res.stdout || Buffer.from('')).toString('utf8'),
    status: res.status,
    stderr: String(res.stderr || ''),
  };
}

function walkFiles(dir, cb) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch (_) {
      continue;
    }
    if (st.isDirectory()) walkFiles(p, cb);
    else cb(p);
  }
}

function tmpStrayFiles(dir) {
  const hits = [];
  walkFiles(dir, (p) => {
    if (/\.tmp-\d+-/.test(path.basename(p))) hits.push(p);
  });
  return hits;
}

// Mirror of recall.js dedupStatePath sanitization.
function stateFileFor(sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^\w.-]/g, '_');
  return path.join(os.tmpdir(), 'teamlore-' + safe + '-injected.txt');
}

let counter = 0;
function sid(tag) {
  counter++;
  return 'a6-' + tag + '-' + Date.now() + '-' + counter;
}

// Lore fixture repo: git repo, one untracked matching file (prompt-mode
// working set), lore entries passed in as { name, glob, body }.
function mkLoreRepo(entries) {
  const repo = tmpDir('tl-a6-lore-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, 'src', 'payments'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'payments', 'new.js'), 'x;\n');
  for (const e of entries) {
    write(
      path.join(repo, '.lore', e.name),
      '---\npaths:\n  - "' + e.glob + '"\nkind: gotcha\nby: a6\ncommit: t\nverify_by: 2027-01-01\n---\n' +
        (e.body || 'Lesson body ' + e.name + '.\n')
    );
  }
  return repo;
}

// ==========================================================================
// F1 deepened — HOOK_MARKER ('skills/teamlore/scripts') SUBSTRING strip
// ==========================================================================

test('F1a cursor remove: a user hooks.json whose only hook MERELY MENTIONS the marker is deleted whole (removable path)', () => {
  const repo = tmpDir('tl-a6-f1a-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.cursor'));
  const hooksPath = path.join(repo, '.cursor', 'hooks.json');
  // User-authored file; the hook belongs to an unrelated tool that happens to
  // reference the teamlore scripts path (e.g. a path-scoped logger).
  const userFile =
    '{\n  "version": 1,\n  "hooks": {\n    "stop": [\n      ' +
    '{ "command": "node my-logger.js skills/teamlore/scripts" }\n    ]\n  }\n}\n';
  write(hooksPath, userFile);

  const r = teamlore(['remove'], repo, fakeHomeEnv(tmpDir('tl-a6-f1a-home-')));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const deleted = !fs.existsSync(hooksPath);
  if (deleted) {
    verdict('CONFIRMED-EXPLOIT', 'F1a', 2,
      'remove DELETED the user-authored .cursor/hooks.json (stripCursorHooksText "removable": ' +
      'doc reduced to {version:1} because the decoy command contains HOOK_MARKER). Whole-file ' +
      'deletion from a substring match — user data loss, S4 violated.');
  } else {
    verdict('SAFE', 'F1a', 3, 'file survived remove (behavior changed since finding)');
  }
  assert.strictEqual(deleted, true, 'current behavior: file deleted (finding F1a)');

  // Variant: one real user hook next to the decoy — file kept, decoy stripped.
  const repo2 = tmpDir('tl-a6-f1a2-');
  gitInit(repo2);
  fs.mkdirSync(path.join(repo2, '.cursor'));
  const hooksPath2 = path.join(repo2, '.cursor', 'hooks.json');
  write(hooksPath2, '{\n  "version": 1,\n  "hooks": {\n    "stop": [\n      ' +
    '{ "command": "node my-logger.js skills/teamlore/scripts" },\n      ' +
    '{ "command": "node format.js" }\n    ]\n  }\n}\n');
  const r2 = teamlore(['remove'], repo2, fakeHomeEnv(tmpDir('tl-a6-f1a2-home-')));
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  const after = JSON.parse(read(hooksPath2));
  assert.deepStrictEqual(after.hooks.stop, [{ command: 'node format.js' }],
    'the marker-free user hook must survive');
  verdict('CONFIRMED-EXPLOIT', 'F1a2', 2,
    'any user hook whose command merely CONTAINS "skills/teamlore/scripts" is stripped by ' +
    'remove (substring scan over every event). Init is exact-match-safe; remove is not.');
});

test('F1b claude remove: same substring class via shared stripSettingsObject — foreign hook under PostToolUse is unwired', () => {
  const repo = tmpDir('tl-a6-f1b-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.claude'));
  const settingsPath = path.join(repo, '.claude', 'settings.json');
  const DECOY = 'node audit.js --watch "$CLAUDE_PROJECT_DIR/.claude/skills/teamlore/scripts"';
  write(settingsPath, JSON.stringify({
    model: 'opus',
    hooks: {
      PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: DECOY }] }],
      Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'node notify.js' }] }],
    },
  }, null, 2) + '\n');

  const r = teamlore(['remove'], repo, fakeHomeEnv(tmpDir('tl-a6-f1b-home-')));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = JSON.parse(read(settingsPath));
  assert.strictEqual(after.model, 'opus', 'unrelated settings key preserved');
  assert.ok(JSON.stringify(after).includes('node notify.js'), 'marker-free hook preserved');
  if (!JSON.stringify(after).includes('audit.js')) {
    verdict('CONFIRMED-EXPLOIT', 'F1b', 2,
      'claude remove strips a foreign PostToolUse hook because its command contains the marker ' +
      'substring (stripSettingsObject is shared by claude+zcode adapters — the F1 class is ' +
      'repo-wide, not cursor-specific).');
  } else {
    verdict('SAFE', 'F1b', 3, 'decoy survived (behavior changed since finding)');
  }
  assert.ok(!JSON.stringify(after).includes('audit.js'), 'current behavior: decoy stripped (F1b)');
});

// ==========================================================================
// F2 deepened — kimi whole-[[hooks]]-stanza strip
// ==========================================================================

test('F2a kimi remove: a user stanza whose COMMENT mentions the marker is stripped whole', () => {
  const home = tmpDir('tl-a6-f2a-home-');
  const repo = tmpDir('tl-a6-f2a-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.kimi-code'));
  const tomlPath = path.join(home, '.kimi-code', 'config.toml');
  const original = [
    '[[hooks]]',
    'event = "SubagentStop"',
    'command = "node own-hook.js"',
    '# note: mirrors the skills/teamlore/scripts layout for local runs',
    'priority = 3',
    '',
  ].join('\n');
  write(tomlPath, original);
  const env = fakeHomeEnv(home);

  const r = teamlore(['remove'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = read(tomlPath);
  if (!after.includes('own-hook.js')) {
    verdict('CONFIRMED-EXPLOIT', 'F2a', 2,
      'remove stripped the user ENTIRE stanza because a comment line contains HOOK_MARKER — ' +
      'comment text alone counts as ownership (stripHookStanzas scans every line, comments ' +
      'included). User hook + user keys gone from a machine-global config.');
  } else {
    verdict('SAFE', 'F2a', 3, 'comment-mention no longer strips the stanza');
  }
  assert.ok(!after.includes('own-hook.js'), 'current behavior: stanza stripped (F2a)');

  // Real user keys sharing the teamlore stanza (A3's B6) — re-confirm severity.
  const home2 = tmpDir('tl-a6-f2a2-home-');
  const repo2 = tmpDir('tl-a6-f2a2-');
  gitInit(repo2);
  fs.mkdirSync(path.join(repo2, '.kimi-code'));
  const tomlPath2 = path.join(home2, '.kimi-code', 'config.toml');
  write(tomlPath2, [
    '[[hooks]]',
    'event = "UserPromptSubmit"',
    'command = "node ' + home2.split(path.sep).join('/') + '/.kimi-code/skills/teamlore/scripts/recall.js prompt --host kimi"',
    'priority = 5',
    'timeout_ms = 2000',
    '',
  ].join('\n'));
  const r2 = teamlore(['remove'], repo2, fakeHomeEnv(home2));
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  const after2 = read(tomlPath2);
  assert.ok(!after2.includes('priority = 5') && !after2.includes('timeout_ms = 2000'),
    'user keys sharing the stanza die with it');
  verdict('CONFIRMED-EXPLOIT', 'F2a2', 2,
    'user keys (priority, timeout_ms) sharing the teamlore stanza are deleted with it — no ' +
    'key-level granularity. Correct semantics: strip only the teamlore-owned keys (command line ' +
    'matching HOOK_MARKER), drop the stanza only when nothing user-owned remains; a comment ' +
    'must never count as ownership.');
});

test('F2b kimi remove with nested [[hooks.subtable]]: only the marker stanza goes, user stanza + subtable stay byte-exact', () => {
  const home = tmpDir('tl-a6-f2b-home-');
  const repo = tmpDir('tl-a6-f2b-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.kimi-code'));
  const tomlPath = path.join(home, '.kimi-code', 'config.toml');
  const original = [
    '[[hooks]]',
    'event = "PreToolUse"',
    'command = "node own-lint.js"',
    '',
    '[[hooks.subtable]]',
    'filter = "bash"',
    '',
    '[[hooks]]',
    'event = "UserPromptSubmit"',
    'command = "node ~/.kimi-code/skills/teamlore/scripts/recall.js prompt --host kimi"',
    '',
  ].join('\n');
  write(tomlPath, original);

  const r = teamlore(['remove'], repo, fakeHomeEnv(home));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const expected = original.replace(
    '[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "node ~/.kimi-code/skills/teamlore/scripts/recall.js prompt --host kimi"\n',
    ''
  );
  assert.strictEqual(read(tomlPath), expected,
    'user stanza and nested [[hooks.subtable]] must survive byte-exact; only the TL stanza goes');
  verdict('SAFE', 'F2b', 3,
    'nested subtables are treated as separate stanzas — the marker stanza is removed cleanly, ' +
    'user [[hooks]] + [[hooks.subtable]] stay byte-exact.');
});

// ==========================================================================
// F3 deepened — JSON re-serialization of user configs
// ==========================================================================

test('F3a CRLF .claude/settings.json: whole-file EOL conversion to LF on init (baseline re-confirm)', () => {
  const repo = tmpDir('tl-a6-f3a-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.claude'));
  const settingsPath = path.join(repo, '.claude', 'settings.json');
  const original = '{\r\n  "model": "opus",\r\n  "hooks": {}\r\n}';
  write(settingsPath, original);

  const r = teamlore(['init'], repo, fakeHomeEnv(tmpDir('tl-a6-f3a-home-')));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = read(settingsPath);
  const parsed = JSON.parse(after);
  assert.strictEqual(parsed.model, 'opus', 'data survives the round-trip');
  if (!after.includes('\r\n')) {
    verdict('CONFIRMED-EXPLOIT', 'F3a', 3,
      'init rewrote EVERY line ending of the user file CRLF->LF (JSON.stringify ' +
      're-serialization). Data intact, bytes not — beyond teamlore\'s own additions.');
  } else {
    verdict('SAFE', 'F3a', 3, 'CRLF preserved (behavior changed since finding)');
  }
  assert.ok(!after.includes('\r\n'), 'current behavior: whole file LF (F3a)');
});

test('F3b duplicate JSON keys: init silently collapses to the last value (first value unrecoverable)', () => {
  const repo = tmpDir('tl-a6-f3b-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.claude'));
  const settingsPath = path.join(repo, '.claude', 'settings.json');
  write(settingsPath, '{\n  "version": 1,\n  "version": 2,\n  "model": "opus"\n}');

  const r = teamlore(['init'], repo, fakeHomeEnv(tmpDir('tl-a6-f3b-home-')));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = read(settingsPath);
  assert.strictEqual(JSON.parse(after).version, 2, 'last duplicate wins (JSON.parse semantics)');
  const occurrences = after.split('"version"').length - 1;
  if (occurrences === 1) {
    verdict('CONFIRMED-EXPLOIT', 'F3b', 3,
      'duplicate keys are silently deduped by parse->stringify (first "version": 1 dropped ' +
      'without any refusal or warning). F3 class: re-serialization is not byte-faithful to ' +
      'the textual record.');
  } else {
    verdict('SAFE', 'F3b', 3, 'duplicate keys preserved (behavior changed since finding)');
  }
  assert.strictEqual(occurrences, 1, 'current behavior: dup key collapsed (F3b)');
});

test('F3c integer-like JSON keys are reordered to the front by re-serialization', () => {
  const repo = tmpDir('tl-a6-f3c-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.claude'));
  const settingsPath = path.join(repo, '.claude', 'settings.json');
  write(settingsPath, '{\n  "zz": 1,\n  "10": 2,\n  "2": 3,\n  "aa": 4\n}');

  const r = teamlore(['init'], repo, fakeHomeEnv(tmpDir('tl-a6-f3c-home-')));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = read(settingsPath);
  const parsed = JSON.parse(after);
  assert.strictEqual(parsed['10'], 2, 'values intact');
  if (after.trimStart().startsWith('{"2"') || after.trimStart().startsWith('{\n  "2"')) {
    verdict('FINDING', 'F3c', 3,
      'integer-like keys ("2","10") are hoisted to the front of the file by JSON.stringify — ' +
      'user key ORDER rewritten beyond teamlore\'s additions (same F3 re-serialization class, ' +
      'semantics preserved).');
  } else {
    verdict('SAFE', 'F3c', 3, 'key order preserved (behavior changed since finding)');
  }
  assert.ok(after.indexOf('"2"') < after.indexOf('"zz"'), 'current behavior: keys reordered (F3c)');
});

test('F3d UTF-8 BOM / JSONC comments in settings.json: refused, never corrupted (init AND remove)', () => {
  const env = fakeHomeEnv(tmpDir('tl-a6-f3d-home-'));

  const repo1 = tmpDir('tl-a6-f3d1-');
  gitInit(repo1);
  fs.mkdirSync(path.join(repo1, '.claude'));
  const p1 = path.join(repo1, '.claude', 'settings.json');
  const bom = '\uFEFF{ "model": "opus" }';
  write(p1, bom);
  const r1 = teamlore(['init'], repo1, env);
  assert.strictEqual(r1.status, 1, 'init must refuse a BOM-prefixed settings.json');
  assert.ok(r1.stdout.includes('refusing'), 'refusal message surfaced: ' + r1.stdout);
  assert.ok(sameBytes(readBuf(p1), Buffer.from(bom, 'utf8')), 'BOM file byte-identical after refused init');
  const r1b = teamlore(['remove'], repo1, env);
  assert.strictEqual(r1b.status, 0, r1b.stdout + r1b.stderr);
  assert.ok(sameBytes(readBuf(p1), Buffer.from(bom, 'utf8')), 'BOM file byte-identical after remove');

  const repo2 = tmpDir('tl-a6-f3d2-');
  gitInit(repo2);
  fs.mkdirSync(path.join(repo2, '.claude'));
  const p2 = path.join(repo2, '.claude', 'settings.json');
  const jsonc = '{\n  // allow-comments\n  "model": "opus"\n}';
  write(p2, jsonc);
  const r2 = teamlore(['init'], repo2, env);
  assert.strictEqual(r2.status, 1, 'init must refuse JSONC');
  assert.ok(sameBytes(readBuf(p2), Buffer.from(jsonc, 'utf8')), 'JSONC file untouched');
  verdict('SAFE', 'F3d', 3,
    'BOM-prefixed and JSONC settings.json are REFUSED (exit 1 on init, warning on remove) and ' +
    'left byte-identical — no corruption path.');
});

test('F3f very deep nesting: either works or refuses cleanly — file never corrupted', () => {
  const env = fakeHomeEnv(tmpDir('tl-a6-f3f-home-'));

  // 50k-deep object: JSON.parse survives, JSON.stringify overflows -> refusal.
  const repo1 = tmpDir('tl-a6-f3f1-');
  gitInit(repo1);
  fs.mkdirSync(path.join(repo1, '.claude'));
  const p1 = path.join(repo1, '.claude', 'settings.json');
  const deep = '{"a":'.repeat(50000) + '1' + '}'.repeat(50000);
  write(p1, deep);
  const r1 = teamlore(['init'], repo1, env);
  assert.strictEqual(r1.status, 1, 'init must not half-apply a config it cannot re-serialize');
  assert.ok(sameBytes(readBuf(p1), Buffer.from(deep, 'utf8')), 'deep file byte-identical');
  console.log('    (deep-nesting refusal message: ' + r1.stdout.split('\n').filter((l) => l.includes('!')).join(' | ').trim().slice(0, 120) + ')');

  // 1k-deep object: parse+stringify both fine -> init succeeds, data intact.
  const repo2 = tmpDir('tl-a6-f3f2-');
  gitInit(repo2);
  fs.mkdirSync(path.join(repo2, '.claude'));
  const p2 = path.join(repo2, '.claude', 'settings.json');
  const medium = '{"a":'.repeat(1000) + '1' + '}'.repeat(1000);
  write(p2, medium);
  const r2 = teamlore(['init'], repo2, env);
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  const parsed = JSON.parse(read(p2));
  let node = parsed;
  while (node && node.a && typeof node.a === 'object') node = node.a;
  assert.strictEqual(node.a, 1, 'deep payload intact after successful merge');
  verdict('SAFE', 'F3f', 3,
    '50k-deep config: refusal-by-exception (RangeError surfaced as warning, exit 1, file ' +
    'byte-identical; message is unstyled but safe). 1k-deep: works, data intact. No corruption.');
});

// ==========================================================================
// F4 deepened — AGENTS.md marker strip
// ==========================================================================

test('F4a AGENTS.md markers inside a fenced code block: init silently skips install; remove deletes the fenced example', () => {
  const repo = tmpDir('tl-a6-f4a-');
  gitInit(repo);
  const agentsPath = path.join(repo, 'AGENTS.md');
  const original =
    '# Docs\n\n```md\n<!-- teamlore:start -->\nexample config — not real\n<!-- teamlore:end -->\n```\n';
  write(agentsPath, original);

  const r = teamlore(['init', '--agents', 'cursor'], repo, fakeHomeEnv(tmpDir('tl-a6-f4a-home-')));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(read(agentsPath), original,
    'init must not touch the file (it does) — but it also silently installs nothing');

  const r2 = teamlore(['remove'], repo, fakeHomeEnv(tmpDir('tl-a6-f4a2-home-')));
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  const after = read(agentsPath);
  if (!after.includes('example config')) {
    verdict('CONFIRMED-EXPLOIT', 'F4a', 2,
      'AGENTS.md strip operates on raw text with no fence awareness: markers inside a ``` code ' +
      'block are treated as real, so remove deleted the user\'s documented example line from ' +
      'inside their fence; init also silently skipped installing the fallback (double damage).');
  } else {
    verdict('SAFE', 'F4a', 3, 'fenced markers ignored (behavior changed since finding)');
  }
  assert.strictEqual(after, '# Docs\n\n```md\n```\n', 'current behavior: fenced example deleted (F4a)');
});

test('F4b AGENTS.md user text glued to markers is fused into one word on remove', () => {
  const repo = tmpDir('tl-a6-f4b-');
  gitInit(repo);
  const agentsPath = path.join(repo, 'AGENTS.md');
  write(agentsPath, 'Version<!-- teamlore:start -->x\n<!-- teamlore:end -->Changelog\n');

  const r = teamlore(['remove'], repo, fakeHomeEnv(tmpDir('tl-a6-f4b-home-')));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = read(agentsPath);
  if (after === 'VersionChangelog\n') {
    verdict('CONFIRMED-EXPLOIT', 'F4b', 3,
      'content immediately adjacent to the markers (no blank lines) is FUSED on strip: ' +
      '"Version"+"Changelog" became "VersionChangelog" — outside-marker text rewritten.');
  } else {
    verdict('SAFE', 'F4b', 3, 'adjacent text kept separate (behavior changed since finding)');
  }
  assert.strictEqual(after, 'VersionChangelog\n', 'current behavior: words fused (F4b)');
});

test('F4c AGENTS.md seam blank-line collapse (F4 baseline) — outside content rewritten', () => {
  const repo = tmpDir('tl-a6-f4c-');
  gitInit(repo);
  const agentsPath = path.join(repo, 'AGENTS.md');
  const original = 'A\n\n<!-- teamlore:start -->\nsec\n<!-- teamlore:end -->\n\n\nB\n';
  write(agentsPath, original);

  const r = teamlore(['remove'], repo, fakeHomeEnv(tmpDir('tl-a6-f4c-home-')));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = read(agentsPath);
  assert.strictEqual(after, 'A\nB\n', 'seam whitespace is normalized');
  verdict('FINDING', 'F4c', 3,
    'strip rewrites OUTSIDE-marker bytes: \\n+$ -> \\n and ^\\n+ -> "" collapse the seam ' +
    'blank lines (A\\n\\n...\\n\\n\\nB -> A\\nB). Semantics preserved, bytes not — document ' +
    'or make the strip splice byte-exact.');
});

// ==========================================================================
// N1 — zcode ~/.zcode/cli/config.json hostility
// ==========================================================================

test('N1a zcode: top-level ARRAY config — init refuses (exit 1), remove ignores, bytes untouched both ways', () => {
  const home = tmpDir('tl-a6-n1a-home-');
  const repo = tmpDir('tl-a6-n1a-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.zcode'));
  const cfg = path.join(home, '.zcode', 'cli', 'config.json');
  const original = '["one", 2, {"three": true}]';
  write(cfg, original);
  const env = fakeHomeEnv(home);

  const r = teamlore(['init', '--agents', 'zcode'], repo, env);
  assert.strictEqual(r.status, 1, 'init must refuse a non-object config');
  assert.ok(r.stdout.includes('not a JSON object'), 'refusal surfaced: ' + r.stdout);
  assert.ok(sameBytes(readBuf(cfg), Buffer.from(original)), 'array config untouched by init');
  const r2 = teamlore(['remove'], repo, env);
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  assert.ok(sameBytes(readBuf(cfg), Buffer.from(original)), 'array config untouched by remove');
  verdict('SAFE', 'N1a', 3, 'top-level array: refused on init, ignored on remove, byte-identical throughout.');
});

test('N1b zcode: hooks as a non-object (string / number) is SILENTLY REPLACED by init', () => {
  const home = tmpDir('tl-a6-n1b-home-');
  const repo = tmpDir('tl-a6-n1b-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.zcode'));
  const cfg = path.join(home, '.zcode', 'cli', 'config.json');
  write(cfg, '{\n  "hooks": "profile-a",\n  "mcp": { "server-x": { "cmd": "y" } }\n}');

  const r = teamlore(['init', '--agents', 'zcode'], repo, fakeHomeEnv(home));
  assert.strictEqual(r.status, 0, 'init does not refuse a string hooks value');
  const after = read(cfg);
  const parsed = JSON.parse(after);
  assert.strictEqual(parsed.mcp['server-x'].cmd, 'y', 'unrelated keys preserved');
  if (!after.includes('profile-a')) {
    verdict('CONFIRMED-EXPLOIT', 'N1b', 3,
      'init silently REPLACED the user\'s "hooks": "profile-a" with a fresh object — the string ' +
      'value is gone without any warning (violates the "unknown keys preserved" / refuse-on-' +
      'odd-shape guarantee; top-level shape IS guarded, the hooks key is not).');
  } else {
    verdict('SAFE', 'N1b', 3, 'non-object hooks preserved (behavior changed since finding)');
  }
  assert.ok(!after.includes('profile-a'), 'current behavior: hooks string clobbered (N1b)');

  // number variant shares the same code path — verify once.
  const home2 = tmpDir('tl-a6-n1b2-home-');
  const repo2 = tmpDir('tl-a6-n1b2-');
  gitInit(repo2);
  fs.mkdirSync(path.join(repo2, '.zcode'));
  write(path.join(home2, '.zcode', 'cli', 'config.json'), '{ "hooks": 42 }');
  const r2 = teamlore(['init', '--agents', 'zcode'], repo2, fakeHomeEnv(home2));
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  assert.ok(!read(path.join(home2, '.zcode', 'cli', 'config.json')).includes('42'),
    'number hooks value also replaced (same path)');
});

test('N1c zcode: hooks.enabled = "true" (string) — preserved + warning, never flipped', () => {
  const home = tmpDir('tl-a6-n1c-home-');
  const repo = tmpDir('tl-a6-n1c-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.zcode'));
  const cfg = path.join(home, '.zcode', 'cli', 'config.json');
  write(cfg, '{\n  "hooks": { "enabled": "true" },\n  "mcp": { "a": 1 }\n}');
  const before = read(cfg);

  const r = teamlore(['init', '--agents', 'zcode'], repo, fakeHomeEnv(home));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const parsed = JSON.parse(read(cfg));
  assert.strictEqual(parsed.hooks.enabled, 'true', 'string enabled preserved as-is');
  assert.ok(r.stdout.includes('hooks.enabled is not true'), 'warning printed: ' + r.stdout);
  verdict('SAFE', 'N1c', 3,
    'enabled:"true" (string) is preserved untouched with an explicit warning — teamlore never ' +
    'flips or deletes it (remove also leaves enabled alone).');
  assert.ok(!before.includes('"events"') && parsed.hooks.events, 'wiring still added around it');
});

test('N1d zcode: teamlore command relocated under a DIFFERENT event — init cross-event dedupes, remove unwinds it there', () => {
  const home = tmpDir('tl-a6-n1d-home-');
  const repo = tmpDir('tl-a6-n1d-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.zcode'));
  const cfg = path.join(home, '.zcode', 'cli', 'config.json');
  const stopCmd = 'node "' +
    path.join(home, '.zcode', 'skills', 'teamlore').split(path.sep).join('/') +
    '/scripts/distill-check.js" --host zcode';
  write(cfg, JSON.stringify({
    hooks: {
      enabled: true,
      events: {
        PreToolUse: [{ hooks: [{ type: 'command', command: stopCmd }] }],
      },
    },
  }, null, 2) + '\n');
  const env = fakeHomeEnv(home);

  const r = teamlore(['init', '--agents', 'zcode'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const merged = JSON.parse(read(cfg));
  assert.strictEqual(merged.hooks.events.Stop, undefined,
    'Stop wiring suppressed: the exact command already exists under PreToolUse');
  assert.ok(merged.hooks.events.SessionStart && merged.hooks.events.UserPromptSubmit,
    'the other two events are wired normally');
  assert.ok(JSON.stringify(merged.hooks.events.PreToolUse).includes('distill-check.js'),
    'relocated entry left in place by init');

  const r2 = teamlore(['remove'], repo, env);
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  const after = JSON.parse(read(cfg));
  assert.strictEqual(after.hooks.enabled, true, 'enabled never flipped by remove');
  assert.ok(!after.hooks.events || after.hooks.events.PreToolUse === undefined,
    'remove unwinds the relocated teamlore command from the custom event');
  verdict('FINDING', 'N1d', 3,
    'exact-command dedupe spans ALL events: a user-relocated teamlore command silently ' +
    'suppresses canonical wiring for that event (init reports wired, the event never fires). ' +
    'Remove unwinds it from the custom event. Consistent with A4 (claude) — marker semantics ' +
    'own the exact command string. Document; no corruption.');
});

test('N1e zcode: 2MB user config — every unrelated key preserved, hooks added, fast', () => {
  const home = tmpDir('tl-a6-n1e-home-');
  const repo = tmpDir('tl-a6-n1e-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.zcode'));
  const cfg = path.join(home, '.zcode', 'cli', 'config.json');
  const big = {};
  for (let i = 0; i < 40000; i++) big['key' + i] = { v: i, pad: 'x'.repeat(40) };
  write(cfg, JSON.stringify(big));

  const t0 = Date.now();
  const r = teamlore(['init', '--agents', 'zcode'], repo, fakeHomeEnv(home));
  const ms = Date.now() - t0;
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const parsed = JSON.parse(read(cfg));
  let missing = 0;
  for (let i = 0; i < 40000; i++) if (!parsed['key' + i] || parsed['key' + i].v !== i) missing++;
  assert.strictEqual(missing, 0, 'all 40000 unrelated keys preserved');
  assert.ok(parsed.hooks.events.SessionStart, 'hooks merged into the 2MB doc');
  assert.ok(ms < 30000, '2MB merge took ' + ms + 'ms');
  verdict('SAFE', 'N1e', 3, '2MB / 40k-key config: all unrelated keys preserved, hooks merged, ' + ms + 'ms.');
});

test('N1f ~/.zcode/cli exists as a FILE: init exits 1 with a warning, the file is untouched, no crash', () => {
  const home = tmpDir('tl-a6-n1f-home-');
  const repo = tmpDir('tl-a6-n1f-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.zcode'));
  fs.mkdirSync(path.join(home, '.zcode'));
  const cliFile = path.join(home, '.zcode', 'cli');
  fs.writeFileSync(cliFile, 'i am a file, not a directory');
  const env = fakeHomeEnv(home);

  const r = teamlore(['init', '--agents', 'zcode'], repo, env);
  assert.strictEqual(r.status, 1, 'init must surface the failure, exit 1 (got: ' + r.status + ')');
  assert.ok(r.stdout.includes('!'), 'warning row printed: ' + r.stdout);
  assert.strictEqual(fs.readFileSync(cliFile, 'utf8'), 'i am a file, not a directory',
    'the file masquerading as the config dir is untouched');
  assert.ok(!fs.existsSync(path.join(home, '.zcode', 'cli', 'config.json')), 'no config created');
  assert.ok(fs.existsSync(path.join(repo, '.zcode', 'skills', 'teamlore', 'SKILL.md')),
    'project-level install still completed before the global refusal');
  verdict('SAFE', 'N1f', 3,
    'ensureDir over a file -> error caught by the adapter loop, styled warning, exit 1, ' +
    'machine file untouched. Partial (project-only) install is the documented continue-on-warning mode.');
});

// ==========================================================================
// N2 — kimi TOML hostility
// ==========================================================================

test('N2a kimi: UTF-8 BOM config.toml — append preserves BOM bytes; remove restores byte-exact', () => {
  const home = tmpDir('tl-a6-n2a-home-');
  const repo = tmpDir('tl-a6-n2a-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.kimi-code'));
  const tomlPath = path.join(home, '.kimi-code', 'config.toml');
  const original = '\uFEFF# kimi config\n[profile]\nname = "x"\n';
  write(tomlPath, original);
  const env = fakeHomeEnv(home);

  const r = teamlore(['init', '--agents', 'kimi'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const appended = readBuf(tomlPath);
  assert.ok(appended.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOM still first bytes');
  assert.ok(appended.toString('utf8').startsWith(original), 'original bytes untouched');
  assert.ok(appended.toString('utf8').includes('[[hooks]]'), 'stanza appended');

  const r2 = teamlore(['remove'], repo, env);
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  assert.ok(sameBytes(readBuf(tomlPath), Buffer.from(original, 'utf8')), 'byte-exact restore');
  verdict('SAFE', 'N2a', 3, 'UTF-8 BOM survives append and remove byte-exactly.');
});

test('N2b kimi: non-UTF-8 (CP1256) config.toml is silently transcoded to U+FFFD by init — bytes never recoverable', () => {
  const home = tmpDir('tl-a6-n2b-home-');
  const repo = tmpDir('tl-a6-n2b-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.kimi-code'));
  const tomlPath = path.join(home, '.kimi-code', 'config.toml');
  // "الس" in Windows-1256 + a valid TOML body.
  const cp1256 = Buffer.from([0xc7, 0xe1, 0xd3]);
  fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
  fs.writeFileSync(tomlPath, Buffer.concat([cp1256, Buffer.from('\n[profile]\nname = "x"\n', 'utf8')]));

  const r = teamlore(['init', '--agents', 'kimi'], repo, fakeHomeEnv(home));
  assert.strictEqual(r.status, 0, 'init does not detect the invalid UTF-8');
  const after = readBuf(tomlPath);
  const mangled = !after.slice(0, 3).equals(cp1256);
  if (mangled) {
    verdict('CONFIRMED-EXPLOIT', 'N2b', 3,
      'read-modify-write decodes as UTF-8: 0xC7 0xE1 0xD3 became U+FFFD sequences on init — ' +
      'the user\'s bytes are destroyed and cannot be restored by remove. A UTF-8 validity ' +
      'check (refuse + manual instructions) is the safe behavior.');
  } else {
    verdict('SAFE', 'N2b', 3, 'non-UTF-8 bytes preserved (behavior changed since finding)');
  }
  assert.ok(mangled, 'current behavior: non-UTF-8 transcoded (N2b)');
  assert.ok(after.toString('utf8').includes('[[hooks]]'), 'stanza still appended');

  const r2 = teamlore(['remove'], repo, fakeHomeEnv(home));
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  assert.ok(!readBuf(tomlPath).toString('utf8').includes('teamlore'), 'stanza removed; Arabic stays mangled');
});

test('N2c kimi: two teamlore stanzas separated by user stanzas — exactly the two go, everything else byte-exact', () => {
  const home = tmpDir('tl-a6-n2c-home-');
  const repo = tmpDir('tl-a6-n2c-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.kimi-code'));
  const tomlPath = path.join(home, '.kimi-code', 'config.toml');
  const TL = '[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "node ~/.kimi-code/skills/teamlore/scripts/recall.js prompt --host kimi"\n';
  const userA = '[[hooks]]\nevent = "PreToolUse"\ncommand = "node own-a.js"\n\n';
  const userB = '[[hooks]]\nevent = "SessionStart"\ncommand = "node own-b.js"\n\n';
  const provider = '[profile]\nname = "work"\n';
  const original = userA + TL + userB + TL + provider;
  write(tomlPath, original);

  const r = teamlore(['remove'], repo, fakeHomeEnv(home));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = read(tomlPath);
  assert.strictEqual(after, userA + userB + provider,
    'exactly the two marker stanzas removed; user stanzas + provider table byte-exact');
  verdict('SAFE', 'N2c', 3, 'interleaved stanzas: both marker stanzas stripped, foreign bytes intact.');
});

test('N2d kimi: home dir with space, apostrophe, percent and Arabic — stanza command escaped correctly, remove byte-exact', () => {
  const base = tmpDir('tl-a6-n2d-base-');
  const home = path.join(base, "O'Brien %dir مصر");
  fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
  const repo = tmpDir('tl-a6-n2d-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.kimi-code'));
  const tomlPath = path.join(home, '.kimi-code', 'config.toml');
  const original = '[profile]\nname = "x"\n';
  write(tomlPath, original);
  const env = fakeHomeEnv(home);

  const r = teamlore(['init', '--agents', 'kimi'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const appended = read(tomlPath);
  const m = appended.match(/command = "((?:[^"\\]|\\.)*)"/);
  assert.ok(m, 'escaped command line present');
  const cmd = m[1].replace(/\\(["\\])/g, '$1');
  const expectedCmd = 'node "' +
    path.join(home, '.kimi-code', 'skills', 'teamlore').split(path.sep).join('/') +
    '/scripts/recall.js" prompt --host kimi';
  assert.strictEqual(cmd, expectedCmd, 'TOML escaping round-trips the odd path');

  const r2 = teamlore(['remove'], repo, env);
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  assert.strictEqual(read(tomlPath), original, 'byte-exact restore');
  verdict('SAFE', 'N2d', 3, 'quote/percent/unicode home paths: escaped stanza round-trips, remove restores bytes.');
});

test('N2e kimi: config.toml exists as a DIRECTORY — init refuses (exit 1, no tmp strays), remove warns and continues', () => {
  const home = tmpDir('tl-a6-n2e-home-');
  const repo = tmpDir('tl-a6-n2e-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.kimi-code'));
  fs.mkdirSync(path.join(home, '.kimi-code', 'config.toml'), { recursive: true }); // a directory
  const env = fakeHomeEnv(home);

  const r = teamlore(['init', '--agents', 'kimi'], repo, env);
  assert.strictEqual(r.status, 1, 'init must surface the failure');
  assert.ok(fs.statSync(path.join(home, '.kimi-code', 'config.toml')).isDirectory(),
    'directory untouched');
  assert.strictEqual(tmpStrayFiles(path.join(home, '.kimi-code')).length, 0,
    'writeAtomic cleaned its tmp file after the failed rename');

  const r2 = teamlore(['remove'], repo, env);
  assert.strictEqual(r2.status, 0, 'remove continues past the refusal');
  assert.ok(r2.stdout.includes('!'), 'warning printed on remove too');
  assert.ok(fs.statSync(path.join(home, '.kimi-code', 'config.toml')).isDirectory(),
    'directory still untouched after remove');
  verdict('SAFE', 'N2e', 3,
    'config.toml-as-directory: refused on init (exit 1, tmp cleaned up), warned-and-continued ' +
    'on remove, nothing corrupted.');
});

// ==========================================================================
// N3 — atomic-write tmp hygiene
// ==========================================================================

test('N3a after a full init --agents all + remove: zero stray *.tmp-* files anywhere', () => {
  const home = tmpDir('tl-a6-n3a-home-');
  const repo = tmpDir('tl-a6-n3a-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.claude'));
  fs.mkdirSync(path.join(repo, '.cursor'));
  fs.mkdirSync(path.join(repo, '.zcode'));
  fs.mkdirSync(path.join(repo, '.kimi-code'));
  fs.mkdirSync(path.join(repo, '.opencode'));
  const env = fakeHomeEnv(home);

  const r = teamlore(['init', '--agents', 'all'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  let strays = tmpStrayFiles(repo).concat(tmpStrayFiles(home));
  assert.strictEqual(strays.length, 0, 'no tmp strays after init: ' + strays.join(', '));

  const r2 = teamlore(['remove'], repo, env);
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  strays = tmpStrayFiles(repo).concat(tmpStrayFiles(home));
  assert.strictEqual(strays.length, 0, 'no tmp strays after remove: ' + strays.join(', '));
  verdict('SAFE', 'N3a', 3, 'full init+remove cycle leaves zero *.tmp-* strays in repo or fake home.');
});

test('N3b rename-failure path (read-only hooks.json): tmp file cleaned up, original intact, no strays', () => {
  const repo = tmpDir('tl-a6-n3b-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.cursor'));
  const hooksPath = path.join(repo, '.cursor', 'hooks.json');
  const original = '{\n  "version": 1,\n  "hooks": { "stop": [{ "command": "node mine.js" }] }\n}\n';
  write(hooksPath, original);
  fs.chmodSync(hooksPath, 0o444); // rename-over fails with EPERM on Windows

  const r = teamlore(['init', '--agents', 'cursor'], repo, fakeHomeEnv(tmpDir('tl-a6-n3b-home-')));
  try {
    assert.strictEqual(r.status, 1, 'init surfaces the EPERM as a warning (exit 1)');
    assert.ok(r.stdout.includes('EPERM') || r.stdout.includes('!'), 'OS error surfaced: ' + r.stdout);
    assert.strictEqual(read(hooksPath), original, 'original bytes intact');
    assert.strictEqual(tmpStrayFiles(path.join(repo, '.cursor')).length, 0,
      'writeAtomic unlinked its tmp file in the rename-failure catch');
    verdict('SAFE', 'N3b', 3,
      'failed rename leaves the target byte-identical and removes the tmp sibling — the ' +
      'crash-safe cleanup path works.');
  } finally {
    try { fs.chmodSync(hooksPath, 0o666); } catch (_) { /* cleanup handles */ }
  }
});

// ==========================================================================
// N4 — hook scripts under attack
// ==========================================================================

test('N4a recall with a 10MB prompt: still fast, capped output, exit 0 (no memory/time bomb)', () => {
  const repo = mkLoreRepo([{ name: '2026-01-01-pay.md', glob: 'src/payments/**' }]);
  const bigPrompt = 'x'.repeat(10 * 1024 * 1024) + ' review src/payments now';
  const t0 = Date.now();
  const r = runScript(RECALL, ['prompt'], { cwd: repo, session_id: sid('big'), prompt: bigPrompt }, { cwd: repo });
  const ms = Date.now() - t0;
  assert.strictEqual(r.status, 0, 'exit 0, stderr: ' + r.stderr);
  assert.ok(r.out.length > 0, 'match emitted');
  assert.ok(r.out.length < 4200, 'output capped at ' + r.out.length + ' chars');
  assert.ok(ms < 15000, '10MB prompt handled in ' + ms + 'ms');
  verdict('SAFE', 'N4a', 3, '10MB stdin prompt: exit 0 in ' + ms + 'ms, output still <= MAX_CHARS cap.');
});

test('N4b .lore body of 1MB: MAX_CHARS truncation holds (~3.2KB output)', () => {
  const repo = mkLoreRepo([{
    name: '2026-01-02-huge.md',
    glob: 'src/payments/**',
    body: 'lorem ipsum dolor sit amet '.repeat(40000) /* ~1MB */,
  }]);
  const r = runScript(RECALL, ['prompt'], { cwd: repo, session_id: sid('huge'), prompt: 'src/payments' }, { cwd: repo });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.out.includes('…'), 'lesson truncated with ellipsis');
  assert.ok(r.out.length < 3600, 'output ' + r.out.length + ' chars < 3600');
  verdict('SAFE', 'N4b', 3, '1MB lore body truncated to the 3200-char budget.');
});

test('N4c 50 lore entries with paths: ["**"] (match-everything): MAX_ENTRIES cap respected', () => {
  const entries = [];
  for (let i = 0; i < 50; i++) {
    entries.push({ name: '2026-01-03-e' + i + '.md', glob: '**', body: 'Lesson number ' + i + '.' });
  }
  const repo = mkLoreRepo(entries);
  const r = runScript(RECALL, ['prompt'], { cwd: repo, session_id: sid('starstar'), prompt: 'anything' }, { cwd: repo });
  assert.strictEqual(r.status, 0, r.stderr);
  const envelope = JSON.parse(r.out); // claude envelope: single line, \n-escaped context
  const ctx = envelope.hookSpecificOutput.additionalContext;
  const numbered = ctx.split('\n').filter((l) => /^\d+\. /.test(l)).length;
  assert.strictEqual(numbered, 5, 'exactly MAX_ENTRIES (5) shown, got ' + numbered);
  verdict('SAFE', 'N4c', 3, '"**" matches all 50 entries; the 5-entry cap and char cap both hold.');
});

test('N4d session_id path traversal ("../../evil", "C:\\evil"): sanitized into the tmp state name, nothing written outside os.tmpdir', () => {
  const repo = mkLoreRepo([{ name: '2026-01-04-pay.md', glob: 'src/payments/**' }]);

  const r1 = runScript(RECALL, ['prompt'], { cwd: repo, session_id: '../../evil-a6x', prompt: 'src/payments' }, { cwd: repo });
  assert.strictEqual(r1.status, 0, r1.stderr);
  assert.ok(r1.out.length > 0, 'first traversal-id run emits');
  const expected1 = stateFileFor('../../evil-a6x');
  assert.ok(fs.existsSync(expected1), 'state file is the sanitized name in os.tmpdir: ' + expected1);
  stateFiles.push(expected1);
  assert.ok(!/evil/.test(path.basename(expected1).replace(/_/g, 'x')) || path.basename(expected1).indexOf('/') === -1,
    'state filename contains no path separators');
  assert.strictEqual(fs.readdirSync(repo).filter((n) => n.includes('evil')).length, 0,
    'no evil file in the repo');
  const r1b = runScript(RECALL, ['prompt'], { cwd: repo, session_id: '../../evil-a6x', prompt: 'src/payments' }, { cwd: repo });
  assert.strictEqual(r1b.status, 0);
  assert.strictEqual(r1b.out.length, 0, 'dedupe still works through the sanitized name');

  const r2 = runScript(RECALL, ['prompt'], { cwd: repo, session_id: 'C:\\evil-a6y', prompt: 'src/payments' }, { cwd: repo });
  assert.strictEqual(r2.status, 0, r2.stderr);
  const expected2 = stateFileFor('C:\\evil-a6y');
  assert.ok(fs.existsSync(expected2), 'windows-abs-style id also sanitized: ' + expected2);
  stateFiles.push(expected2);
  verdict('SAFE', 'N4d', 3,
    'session_id traversal is defanged by the [^\\w.-] sanitizer — state stays inside ' +
    'os.tmpdir, dedupe still functions, no files escape.');
});

test('N4e session_id sanitization COLLISION: "../x" and "..\\x" share one dedupe state file', () => {
  const repo = mkLoreRepo([{ name: '2026-01-05-pay.md', glob: 'src/payments/**' }]);

  const r1 = runScript(RECALL, ['prompt'], { cwd: repo, session_id: '../x-a6z', prompt: 'src/payments' }, { cwd: repo });
  assert.strictEqual(r1.status, 0);
  assert.ok(r1.out.length > 0, 'session "../x-a6z" emits');
  const shared = stateFileFor('../x-a6z');
  stateFiles.push(shared);
  assert.strictEqual(stateFileFor('..\\x-a6z'), shared, 'both ids sanitize to the same file');

  const r2 = runScript(RECALL, ['prompt'], { cwd: repo, session_id: '..\\x-a6z', prompt: 'src/payments' }, { cwd: repo });
  assert.strictEqual(r2.status, 0);
  if (r2.out.length === 0) {
    verdict('FINDING', 'N4e', 3,
      'distinct session ids that sanitize identically ("../x-a6z" vs "..\\x-a6z" -> ' +
      '"..._x-a6z") share one dedupe state — session B never sees entries session A already ' +
      'got. Benign direction (a missed repeat, never corruption / over-injection), but the ' +
      'key should encode the raw id (hash) not just the sanitized form.');
  } else {
    verdict('SAFE', 'N4e', 3, 'no cross-session state sharing (behavior changed since finding)');
  }
  assert.strictEqual(r2.out.length, 0, 'current behavior: shared state (N4e)');
});

test('N4f distill-check with unknown --host and dangling --host: claude fallback, exit 0, never crashes', () => {
  const repo = mkLoreRepo([{ name: '2026-01-06-pay.md', glob: 'src/payments/**' }]);
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'teamlore'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'teamlore', '.needs-distill'), '');

  const r1 = runScript(DISTILL, ['--host', 'nosuchhost'], { cwd: repo }, { cwd: repo });
  assert.strictEqual(r1.status, 0, r1.stderr);
  const parsed1 = JSON.parse(r1.out);
  assert.ok(parsed1.hookSpecificOutput && parsed1.hookSpecificOutput.hookEventName === 'Stop',
    'unknown host falls back to the claude Stop envelope');

  // r1 cleared the sentinel (by design) — restore it for the dangling-flag case.
  fs.writeFileSync(path.join(repo, '.claude', 'skills', 'teamlore', '.needs-distill'), '');
  const r2 = runScript(DISTILL, ['--host'], { cwd: repo }, { cwd: repo });
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.ok(JSON.parse(r2.out).hookSpecificOutput, 'dangling --host falls back to claude too');
  verdict('SAFE', 'N4f', 3, 'unknown/dangling --host behaves exactly like claude (fail-open, exit 0).');
});

// ==========================================================================
// N5 — CLI --agents parsing
// ==========================================================================

test('N5a "--agents cursor --agents kimi" (flag twice): FIRST flag wins, kimi silently ignored', () => {
  const home = tmpDir('tl-a6-n5a-home-');
  const repo = tmpDir('tl-a6-n5a-');
  gitInit(repo);
  const env = fakeHomeEnv(home);

  const r = teamlore(['init', '--agents', 'cursor', '--agents', 'kimi'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(repo, '.cursor', 'hooks.json')), 'cursor installed');
  assert.ok(!fs.existsSync(path.join(repo, '.kimi-code')), 'kimi project artifacts absent');
  assert.ok(!fs.existsSync(path.join(home, '.kimi-code', 'config.toml')),
    'kimi machine-global wiring absent');
  verdict('FINDING', 'N5a', 3,
    'repeated --agents: bin takes the FIRST flag and silently drops the rest — the user asked ' +
    'for kimi and got nothing, exit 0, no mention. Conventional CLI is last-flag-wins or an ' +
    'error. No state corruption (kimi is cleanly absent), but the reported outcome is wrong.');
});

test('N5b/N5c/N5d/N5e --agents edge forms: equals form works; bad case/empty error cleanly; empty element tolerated', () => {
  const envOf = () => fakeHomeEnv(tmpDir('tl-a6-n5-home-'));

  // --agents=cursor (equals form)
  const repo1 = tmpDir('tl-a6-n5b-');
  gitInit(repo1);
  const r1 = teamlore(['init', '--agents=cursor'], repo1, envOf());
  assert.strictEqual(r1.status, 0, r1.stdout + r1.stderr);
  assert.ok(fs.existsSync(path.join(repo1, '.cursor', 'hooks.json')), 'equals form installs cursor');
  verdict('SAFE', 'N5b', 3, '--agents=cursor (equals form) parses and installs.');

  // --agents CURSOR (wrong case)
  const repo2 = tmpDir('tl-a6-n5c-');
  gitInit(repo2);
  const r2 = teamlore(['init', '--agents', 'CURSOR'], repo2, envOf());
  assert.strictEqual(r2.status, 1, 'unknown-case id must error');
  assert.ok(r2.stdout.includes('Unknown host'), 'styled error: ' + r2.stdout);
  assert.ok(!fs.existsSync(path.join(repo2, '.lore')), 'no artifacts created at all');
  verdict('SAFE', 'N5c', 3, '--agents CURSOR -> styled error, exit 1, zero artifacts.');

  // --agents "" (empty)
  const repo3 = tmpDir('tl-a6-n5d-');
  gitInit(repo3);
  const r3 = teamlore(['init', '--agents', ''], repo3, envOf());
  assert.strictEqual(r3.status, 1, 'empty list must error');
  assert.ok(r3.stdout.includes('--agents needs a host list'), 'clear message: ' + r3.stdout);
  assert.ok(!fs.existsSync(path.join(repo3, '.lore')), 'no artifacts created');
  verdict('SAFE', 'N5d', 3, '--agents "" -> clear error, exit 1, zero artifacts.');

  // --agents cursor,,kimi (empty element)
  const repo4 = tmpDir('tl-a6-n5e-');
  gitInit(repo4);
  const r4 = teamlore(['init', '--agents', 'cursor,,kimi'], repo4, envOf());
  assert.strictEqual(r4.status, 0, r4.stdout + r4.stderr);
  assert.ok(fs.existsSync(path.join(repo4, '.cursor', 'hooks.json')), 'cursor installed');
  assert.ok(fs.existsSync(path.join(repo4, '.kimi-code', 'skills', 'teamlore', 'SKILL.md')),
    'kimi installed too');
  verdict('SAFE', 'N5e', 3, '--agents cursor,,kimi: empty elements filtered, both hosts installed.');
});

// ==========================================================================
// N6 — .lore/README.md written by the user
// ==========================================================================

test('N6 user-written .lore/README.md and .loreignore are never overwritten (init x2, remove)', () => {
  const repo = tmpDir('tl-a6-n6-');
  gitInit(repo);
  const readme = path.join(repo, '.lore', 'README.md');
  const ign = path.join(repo, '.loreignore');
  fs.mkdirSync(path.join(repo, '.lore'), { recursive: true });
  fs.writeFileSync(readme, '# MY OWN README — do not touch\n\nCustom team conventions.\n');
  fs.writeFileSync(ign, 'node_modules\nsecrets/**\n');
  const env = fakeHomeEnv(tmpDir('tl-a6-n6-home-'));

  for (const args of [['init'], ['init', '--agents', 'cursor']]) {
    const r = teamlore(args, repo, env);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.strictEqual(fs.readFileSync(readme, 'utf8'), '# MY OWN README — do not touch\n\nCustom team conventions.\n',
      'README untouched by ' + args.join(' '));
    assert.strictEqual(fs.readFileSync(ign, 'utf8'), 'node_modules\nsecrets/**\n',
      '.loreignore untouched by ' + args.join(' '));
  }
  const r = teamlore(['remove'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(fs.readFileSync(readme, 'utf8'), '# MY OWN README — do not touch\n\nCustom team conventions.\n',
    'README survives default remove');
  assert.ok(fs.existsSync(path.join(repo, '.lore')), '.lore kept without --purge');
  verdict('SAFE', 'N6', 3,
    'user-authored .lore/README.md and .loreignore survive init, re-init and remove ' +
    'byte-identically (never-overwrite semantics hold).');
});

// ==========================================================================
// N7 — .gitignore rewriting on remove
// ==========================================================================

test('N7 remove rewrites .gitignore non-byte-exactly: 3+ consecutive blank lines collapse', () => {
  const repo = tmpDir('tl-a6-n7-');
  gitInit(repo);
  const gitignore = path.join(repo, '.gitignore');
  write(gitignore, 'node_modules\n');
  const env = fakeHomeEnv(tmpDir('tl-a6-n7-home-'));

  const r0 = teamlore(['init'], repo, env);
  assert.strictEqual(r0.status, 0, r0.stdout + r0.stderr);
  // user appends their own section with several blank lines
  const afterUser = read(gitignore) + '\n\n\n\n# my section\nfoo\n';
  fs.writeFileSync(gitignore, afterUser);

  const r = teamlore(['remove'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = read(gitignore);
  assert.ok(after.includes('foo') && after.includes('# my section') && after.includes('node_modules'),
    'user entries survive semantically');
  if (!after.includes('\n\n\n')) {
    verdict('FINDING', 'N7', 3,
      'cleanGitignoreLines normalizes the WHOLE file (\\n{3,} -> \\n\\n, forced trailing ' +
      'newline): the user\'s 3 blank lines before "# my section" were collapsed. F4-class ' +
      'non-byte-exact rewrite outside teamlore\'s own lines — narrow the rewrite to teamlore ' +
      'lines or document.');
  } else {
    verdict('SAFE', 'N7', 3, 'user blank lines preserved (behavior changed since finding)');
  }
  assert.ok(!after.includes('\n\n\n'), 'current behavior: blank lines collapsed (N7)');
});

// ==========================================================================
// Summary
// ==========================================================================

cleanup();

console.log('\n=== adversarial2 verdict table ===');
for (const v of verdicts) {
  console.log(
    '  ' + v.tag.padEnd(5) + ' ' + v.kind.padEnd(18) + ' P' + v.sev + '  ' + v.msg.split('.')[0]
  );
}
const exploits = verdicts.filter((v) => v.kind === 'CONFIRMED-EXPLOIT');
const safes = verdicts.filter((v) => v.kind === 'SAFE').length;
const findings = verdicts.filter((v) => v.kind === 'FINDING');
console.log('');
console.log('REMEDIATION-NEEDED (ordered by severity):');
const remediation = [
  'F1 (P2) marker-substring strip deletes foreign hooks; cursor "removable" deletes a whole user-authored hooks.json',
  'F2 (P2) kimi stanza-level strip kills user keys/comments sharing the stanza -> key-level strip',
  'F4a (P2) AGENTS.md strip ignores fenced code blocks -> deletes documented examples; init silently skips install',
  'N1b (P3) zcode init silently replaces a non-object hooks value -> refuse-or-preserve + warning',
  'N2b (P3) non-UTF-8 config.toml transcoded to U+FFFD on init -> UTF-8 validity check + refuse',
];
for (const r of remediation) console.log('  - ' + r);
console.log('ACCEPT-WITH-NOTE:');
const accept = [
  'F3 (P3) whole-file JSON re-serialization: CRLF->LF, dup-key collapse, integer-key reorder (semantics preserved)',
  'F4b/F4c (P3) AGENTS.md seam whitespace normalization outside markers',
  'N1d (P3) cross-event exact-command dedupe suppresses canonical wiring (consistent with A4)',
  'N4e (P3) session-id sanitization collisions share dedupe state (benign direction)',
  'N5a (P3) repeated --agents flag: first wins, rest silently dropped (no corruption)',
  'N7 (P3) .gitignore blank-line collapse on remove (semantics preserved)',
];
for (const a of accept) console.log('  - ' + a);
console.log('');
console.log(
  'probes: ' + verdicts.length + ' verdicts (' + exploits.length + ' confirmed-exploit, ' +
    findings.length + ' findings, ' + safes + ' safe) — tests: ' + passed + ' passed, ' + failed + ' failed'
);
if (failed > 0) {
  process.exitCode = 1;
}
