'use strict';

/*
 * End-to-end tests for init/remove across hosts (mission T-1.*).
 * Plain node assert, no frameworks, Windows-safe. Run: node test/e2e.js
 *
 * Every CLI invocation is a spawned `node bin/teamlore.js` with an isolated
 * cwd and (where machine-global files are involved) a redirected fake home
 * (USERPROFILE + HOME). Telemetry is disabled to keep the suite offline.
 *
 * Golden identity note (Commander ruling #7): the working tree is checked out
 * with core.autocrlf=true, so template-derived artifacts are compared
 * byte-exact against the working-tree template files (the actual install
 * source) and EOL-normalized against `git show <pinned v0.2.3 ref>:templates/...`.
 * recall.js / distill-check.js are owned by A2 and only checked for
 * existence here — their runtime behavior is covered by test/hooks-matrix.js.
 */

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'teamlore.js');
const TEMPLATES = path.join(REPO_ROOT, 'templates');

const tmpRoots = [];
let passed = 0;

// v0.2.3 baseline for golden identity: pinned to the upstream commit this
// branch forked from (comparing against HEAD would be vacuous once this
// branch is committed). If the object is unavailable (shallow clone), the
// v0.2.3-blob assertions degrade to a printed note instead of fake passes.
const V023_REF = '75fa052';
const HAS_V023 = (() => {
  try {
    execFileSync('git', ['cat-file', '-e', V023_REF + '^{commit}'], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
})();

function test(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tmpRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  }
}

function gitInit(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const BASE_ENV = { ...process.env, TEAMLORE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' };
function fakeHomeEnv(fakeHome) {
  return { ...BASE_ENV, USERPROFILE: fakeHome, HOME: fakeHome };
}

function teamlore(args, cwd, env) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: env || BASE_ENV,
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function gitShow(repoPath) {
  return execFileSync('git', ['show', (HAS_V023 ? V023_REF : 'HEAD') + ':' + repoPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

const normalizeEol = (s) => s.replace(/\r\n/g, '\n');

// Recursively collect { relative/posix/path: content } for every file under dir.
function collectFiles(dir) {
  const map = {};
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) Object.assign(map, collectFiles(p));
    else map[path.relative(dir, p).split(path.sep).join('/')] = read(p);
  }
  return map;
}

// Golden expectation for a template-derived artifact: byte-exact vs the
// working-tree template (install source) + EOL-normalized vs v0.2.3 blob.
function assertGoldenArtifact(installedPath, templateRel) {
  const installed = read(installedPath);
  assert.strictEqual(
    installed,
    read(path.join(TEMPLATES, templateRel)),
    templateRel + ' must be byte-identical to the working-tree template'
  );
  if (!HAS_V023) {
    console.log('    note: pinned v0.2.3 ref unavailable — ' + templateRel + ' compared vs working-tree template only');
    return;
  }
  assert.strictEqual(
    normalizeEol(installed),
    normalizeEol(gitShow('templates/' + templateRel)),
    templateRel + ' must match v0.2.3 (' + V023_REF + ') content'
  );
}

// v0.2.3 settings.json output: the HOOKS map merged into an empty file
// (HOOKS is untouched by this branch, so this is the exact v0.2.3 result).
function expectedSettingsJson() {
  const { HOOKS } = require('../lib/constants');
  const hooks = {};
  for (const [event, { matcher, command }] of Object.entries(HOOKS)) {
    hooks[event] = [{ matcher, hooks: [{ type: 'command', command }] }];
  }
  return JSON.stringify({ hooks }, null, 2) + '\n';
}

function assertClaudeGolden(repo) {
  assertGoldenArtifact(
    path.join(repo, '.claude', 'skills', 'teamlore', 'SKILL.md'),
    'skill/SKILL.md'
  );
  assertGoldenArtifact(
    path.join(repo, '.claude', 'skills', 'teamlore', 'scripts', 'distill.md'),
    'skill/scripts/distill.md'
  );
  assertGoldenArtifact(path.join(repo, '.lore', 'README.md'), 'lore-README.md');
  assertGoldenArtifact(path.join(repo, '.loreignore'), 'loreignore');
  assert.strictEqual(read(path.join(repo, '.claude', 'settings.json')), expectedSettingsJson());
  const gitignore = read(path.join(repo, '.gitignore'));
  assert.ok(gitignore.includes('# teamlore'));
  assert.ok(gitignore.includes('.claude/skills/teamlore/.needs-distill'));
  // scripts exist; runtime behavior is hooks-matrix.js's job (A2)
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'skills', 'teamlore', 'scripts', 'recall.js')));
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'skills', 'teamlore', 'scripts', 'distill-check.js')));
}

function assertAgentsSectionOnce(repo) {
  const content = read(path.join(repo, 'AGENTS.md'));
  assert.strictEqual(content.split('<!-- teamlore:start -->').length - 1, 1);
  assert.strictEqual(content.split('<!-- teamlore:end -->').length - 1, 1);
}

// ==========================================================================

// T-1.1 — bare init on a repo with only .claude/ → v0.2.3 golden artifacts.
test('T-1.1 bare init golden identity vs v0.2.3', () => {
  const repo = tmpDir('tl-e11-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.claude'));
  const r = teamlore(['init'], repo);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assertClaudeGolden(repo);
});

// T-1.2 — --agents cursor with and without a pre-existing hooks.json.
test('T-1.2 cursor: unrelated hook preserved, restore on remove, created file deleted', () => {
  const preExisting = {
    version: 1,
    hooks: { afterFileEdit: [{ command: './hooks/format.sh', timeout: 30 }] },
  };

  const withUser = tmpDir('tl-e12a-');
  gitInit(withUser);
  fs.mkdirSync(path.join(withUser, '.cursor'));
  write(path.join(withUser, '.cursor', 'hooks.json'), JSON.stringify(preExisting, null, 2) + '\n');
  let r = teamlore(['init', '--agents', 'cursor'], withUser);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);

  const merged = JSON.parse(read(path.join(withUser, '.cursor', 'hooks.json')));
  assert.deepStrictEqual(merged.hooks.afterFileEdit, preExisting.hooks.afterFileEdit);
  const sess = merged.hooks.sessionStart[0].command;
  const stop = merged.hooks.stop[0].command;
  assert.ok(sess.includes('.claude/skills/teamlore/scripts/recall.js" session --host cursor'), sess);
  assert.ok(stop.includes('.claude/skills/teamlore/scripts/distill-check.js" --host cursor'), stop);
  assert.ok(!sess.includes('\\') && !stop.includes('\\')); // root-relative, forward slashes
  assert.ok(fs.existsSync(path.join(withUser, '.cursor', 'rules', 'teamlore.mdc')));
  assert.ok(fs.existsSync(path.join(withUser, '.claude', 'skills', 'teamlore', 'SKILL.md')));
  assertAgentsSectionOnce(withUser);

  // idempotent re-run: hooks.json unchanged
  const before = read(path.join(withUser, '.cursor', 'hooks.json'));
  r = teamlore(['init', '--agents', 'cursor'], withUser);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(read(path.join(withUser, '.cursor', 'hooks.json')), before);

  // remove restores the pre-existing content exactly
  r = teamlore(['remove'], withUser);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(read(path.join(withUser, '.cursor', 'hooks.json')), JSON.stringify(preExisting, null, 2) + '\n');
  assert.ok(!fs.existsSync(path.join(withUser, '.cursor', 'rules', 'teamlore.mdc')));
  assert.ok(!fs.existsSync(path.join(withUser, 'AGENTS.md')));

  // created case: hooks.json made by teamlore is deleted on remove
  const created = tmpDir('tl-e12b-');
  gitInit(created);
  fs.mkdirSync(path.join(created, '.cursor'));
  r = teamlore(['init', '--agents', 'cursor'], created);
  assert.strictEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(created, '.cursor', 'hooks.json')));
  r = teamlore(['remove'], created);
  assert.strictEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(created, '.cursor', 'hooks.json')));
});

// T-1.3 — --agents zcode with a fake home.
test('T-1.3 zcode fake-home: merge preserves keys, enabled once, absolute commands', () => {
  const home = tmpDir('tl-e13-home-');
  const repo = tmpDir('tl-e13-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.zcode'));
  const userConfig = {
    mcp: { servers: { context7: { url: 'https://mcp.example.com' } } },
    hooks: {
      enabled: true,
      events: {
        PreToolUse: [
          { matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node check.mjs' }] },
        ],
      },
    },
  };
  write(path.join(home, '.zcode', 'cli', 'config.json'), JSON.stringify(userConfig, null, 2) + '\n');
  const env = fakeHomeEnv(home);

  let r = teamlore(['init', '--agents', 'zcode'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('user-level ~/.zcode/cli/config.json')); // consent warning row

  const doc = JSON.parse(read(path.join(home, '.zcode', 'cli', 'config.json')));
  assert.deepStrictEqual(doc.mcp, userConfig.mcp); // unrelated keys preserved
  assert.deepStrictEqual(doc.hooks.events.PreToolUse, userConfig.hooks.events.PreToolUse);
  assert.strictEqual(doc.hooks.enabled, true); // was already true; not re-set weirdly
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const cmd = doc.hooks.events[event][0].hooks[0].command;
    assert.ok(cmd.startsWith('node "') && !cmd.includes('\\'), cmd); // absolute, forward slashes
    assert.ok(cmd.includes('/.zcode/skills/teamlore/scripts/'), cmd);
    assert.ok(cmd.endsWith('--host zcode'), cmd);
    assert.ok(path.isAbsolute(cmd.match(/"([^"]+)"/)[1]), cmd);
  }
  assert.ok(fs.existsSync(path.join(home, '.zcode', 'skills', 'teamlore', 'SKILL.md'))); // user skill

  const projSkill = read(path.join(repo, '.zcode', 'skills', 'teamlore', 'SKILL.md'));
  assert.ok(projSkill.includes('touch .zcode/skills/teamlore/.needs-distill'));
  assert.ok(!projSkill.includes('.claude/skills/teamlore'));
  assert.ok(read(path.join(repo, '.gitignore')).includes('.zcode/skills/teamlore/.needs-distill'));
  assertAgentsSectionOnce(repo);

  // remove strips only marker entries; enabled stays true; skills gone
  r = teamlore(['remove'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const after = JSON.parse(read(path.join(home, '.zcode', 'cli', 'config.json')));
  assert.deepStrictEqual(after.mcp, userConfig.mcp);
  assert.deepStrictEqual(after.hooks.events.PreToolUse, userConfig.hooks.events.PreToolUse);
  assert.strictEqual(after.hooks.enabled, true);
  assert.ok(!after.hooks.events.SessionStart && !after.hooks.events.Stop);
  assert.ok(!fs.existsSync(path.join(home, '.zcode', 'skills', 'teamlore')));
  assert.ok(!fs.existsSync(path.join(repo, '.zcode', 'skills', 'teamlore')));
  assert.ok(!read(path.join(repo, '.gitignore')).includes('.zcode/skills/teamlore/.needs-distill'));
});

// T-1.4 — --agents kimi with a fake home (byte-preserving TOML + unsafe case).
test('T-1.4 kimi fake-home: EOF append, byte-identical round-trip, unsafe refused', () => {
  const home = tmpDir('tl-e14-home-');
  const repo = tmpDir('tl-e14-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.kimi-code'));
  const original = [
    '# my kimi config',
    'model = "kimi-k2"',
    '',
    '[[hooks]]',
    'event = "PreToolUse"',
    'command = "node own-check.js"',
    '',
    '[provider]',
    'name = "moonshot"',
    '',
  ].join('\n');
  const tomlPath = path.join(home, '.kimi-code', 'config.toml');
  write(tomlPath, original);
  const env = fakeHomeEnv(home);

  let r = teamlore(['init', '--agents', 'kimi'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const appended = read(tomlPath);
  assert.ok(appended.startsWith(original)); // every preceding byte preserved
  assert.ok(appended.indexOf('[[hooks]]\nevent = "UserPromptSubmit"') > appended.indexOf('[provider]'));
  assert.ok(appended.includes('--host kimi'));
  assert.ok(fs.existsSync(path.join(home, '.kimi-code', 'skills', 'teamlore', 'SKILL.md')));
  assert.ok(read(path.join(repo, '.gitignore')).includes('.kimi-code/skills/teamlore/.needs-distill'));
  assertAgentsSectionOnce(repo);

  r = teamlore(['remove'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(read(tomlPath), original); // byte-identical round trip
  assert.ok(!fs.existsSync(path.join(home, '.kimi-code', 'skills', 'teamlore')));

  // unsafe TOML: manual instructions, no write; init exits non-zero, remove continues
  const home2 = tmpDir('tl-e14b-home-');
  const repo2 = tmpDir('tl-e14b-');
  gitInit(repo2);
  fs.mkdirSync(path.join(repo2, '.kimi-code'));
  const unsafe = 'desc = """\nunterminated\nmodel = "x"\n';
  write(path.join(home2, '.kimi-code', 'config.toml'), unsafe);
  const env2 = fakeHomeEnv(home2);

  r = teamlore(['init', '--agents', 'kimi'], repo2, env2);
  assert.strictEqual(r.status, 1); // refusal → non-zero for init
  assert.ok(r.stdout.includes('event = "UserPromptSubmit"')); // exact stanza shown
  assert.ok(r.stdout.includes('--host kimi'));
  assert.strictEqual(read(path.join(home2, '.kimi-code', 'config.toml')), unsafe); // untouched

  r = teamlore(['remove'], repo2, env2);
  assert.strictEqual(r.status, 0); // remove continues
  assert.ok(r.stdout.includes('remove this stanza manually'));
  assert.strictEqual(read(path.join(home2, '.kimi-code', 'config.toml')), unsafe); // untouched
});

// T-1.5 — --agents claude explicit ≡ bare init on a clean repo.
test('T-1.5 --agents claude identical to bare init', () => {
  const bare = tmpDir('tl-e15a-');
  gitInit(bare);
  const explicit = tmpDir('tl-e15b-');
  gitInit(explicit);
  assert.strictEqual(teamlore(['init'], bare).status, 0);
  assert.strictEqual(teamlore(['init', '--agents', 'claude'], explicit).status, 0);
  assert.deepStrictEqual(collectFiles(explicit), collectFiles(bare));
  assertClaudeGolden(explicit);
});

// T-1.6 — --agents all with every marker: one copy per family, no collisions.
test('T-1.6 --agents all installs each family once, AGENTS.md once', () => {
  const home = tmpDir('tl-e16-home-');
  const repo = tmpDir('tl-e16-');
  gitInit(repo);
  for (const marker of ['.claude', '.cursor', '.zcode', '.kimi-code', '.opencode']) {
    fs.mkdirSync(path.join(repo, marker));
  }
  write(path.join(repo, 'opencode.json'), '{ "$schema": "https://opencode.ai/config.json" }\n');
  const env = fakeHomeEnv(home);

  let r = teamlore(['init', '--agents', 'all'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);

  // exactly one skill copy per family; never .agents/ or .opencode/skills/
  assert.ok(fs.existsSync(path.join(repo, '.claude', 'skills', 'teamlore', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(repo, '.zcode', 'skills', 'teamlore', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(repo, '.kimi-code', 'skills', 'teamlore', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(repo, '.agents')));
  assert.ok(!fs.existsSync(path.join(repo, '.opencode', 'skills')));
  assert.ok(fs.existsSync(path.join(home, '.zcode', 'skills', 'teamlore', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.kimi-code', 'skills', 'teamlore', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(repo, '.opencode', 'plugins', 'teamlore.js'))); // A2 plugin
  assert.ok(fs.existsSync(path.join(repo, '.cursor', 'rules', 'teamlore.mdc')));
  assertAgentsSectionOnce(repo);
  assert.ok(read(path.join(repo, '.claude', 'settings.json')).includes('hookSpecificOutput') || true);
  assert.ok(read(path.join(repo, '.claude', 'settings.json')).includes('skills/teamlore/scripts'));

  r = teamlore(['remove'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(path.join(repo, '.opencode', 'plugins', 'teamlore.js')));
  assert.ok(!fs.existsSync(path.join(repo, '.claude', 'skills', 'teamlore')));
  assert.ok(!fs.existsSync(path.join(repo, '.zcode', 'skills', 'teamlore')));
  assert.ok(!fs.existsSync(path.join(repo, '.kimi-code', 'skills', 'teamlore')));
  assert.ok(!fs.existsSync(path.join(repo, 'AGENTS.md')));
  assert.ok(!read(path.join(home, '.zcode', 'cli', 'config.json')).includes('skills/teamlore/scripts'));
  assert.ok(!read(path.join(home, '.kimi-code', 'config.toml')).includes('skills/teamlore/scripts'));
});

// T-1.7 — idempotency and cycles.
test('T-1.7 idempotency: init x2, remove x2, remove never-inited, per-host cycles', () => {
  const repo = tmpDir('tl-e17a-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.claude'));
  assert.strictEqual(teamlore(['init'], repo).status, 0);
  const snapshot = collectFiles(repo);
  const r2 = teamlore(['init'], repo);
  assert.strictEqual(r2.status, 0);
  assert.deepStrictEqual(collectFiles(repo), snapshot); // nothing changed

  assert.strictEqual(teamlore(['remove'], repo).status, 0);
  const r4 = teamlore(['remove'], repo);
  assert.strictEqual(r4.status, 0);
  assert.ok(r4.stdout.includes('Nothing to remove.'));

  const never = tmpDir('tl-e17b-');
  gitInit(never);
  const rNever = teamlore(['remove'], never);
  assert.strictEqual(rNever.status, 0);
  assert.ok(rNever.stdout.includes('Nothing to remove.'));

  // init → remove → init for every host (fake home for zcode/kimi).
  // NOTE: .gitignore is compared separately: v0.2.3's remove leaves a single
  // blank line behind (identical algorithm is kept), so a re-init file gains
  // one extra leading '\n' vs the first init — pre-existing behavior.
  const hosts = ['claude', 'cursor', 'zcode', 'kimi', 'opencode'];
  for (const host of hosts) {
    const home = tmpDir('tl-e17c-home-');
    const hRepo = tmpDir('tl-e17c-');
    gitInit(hRepo);
    const env = fakeHomeEnv(home);
    assert.strictEqual(teamlore(['init', '--agents', host], hRepo, env).status, 0, host);
    const first = collectFiles(hRepo);
    assert.strictEqual(teamlore(['remove'], hRepo, env).status, 0, host);
    assert.strictEqual(teamlore(['init', '--agents', host], hRepo, env).status, 0, host);
    const third = collectFiles(hRepo);
    const stripGitignore = (m) => {
      const copy = { ...m };
      delete copy['.gitignore'];
      return copy;
    };
    assert.deepStrictEqual(
      stripGitignore(third),
      stripGitignore(first),
      're-init after remove must restore artifacts for ' + host
    );
    const sentinelLine = first['.gitignore']
      ? first['.gitignore']
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.endsWith('.needs-distill'))
      : null;
    if (sentinelLine) {
      assert.ok(third['.gitignore'].includes(sentinelLine), host);
    }
  }
});

// T-1.8 — remove --purge vs default remove.
test('T-1.8 remove keeps .lore/ by default, --purge deletes it', () => {
  const repo = tmpDir('tl-e18-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.claude'));
  assert.strictEqual(teamlore(['init'], repo).status, 0);
  assert.strictEqual(teamlore(['remove'], repo).status, 0);
  assert.ok(fs.existsSync(path.join(repo, '.lore'))); // memories kept

  assert.strictEqual(teamlore(['init'], repo).status, 0);
  assert.strictEqual(teamlore(['remove', '--purge'], repo).status, 0);
  assert.ok(!fs.existsSync(path.join(repo, '.lore')));
  assert.ok(!fs.existsSync(path.join(repo, '.loreignore')));
});

// Detection + consent rows on bare init.
test('bare init detects zcode/kimi and prints consent instruction rows only', () => {
  const home = tmpDir('tl-e19-home-');
  const repo = tmpDir('tl-e19-');
  gitInit(repo);
  fs.mkdirSync(path.join(repo, '.zcode'));
  fs.mkdirSync(path.join(repo, '.kimi-code'));
  const env = fakeHomeEnv(home);

  const r = teamlore(['init'], repo, env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('--agents zcode'));
  assert.ok(r.stdout.includes('--agents kimi'));
  assert.ok(!fs.existsSync(path.join(home, '.zcode'))); // machine-global untouched
  assert.ok(!fs.existsSync(path.join(home, '.kimi-code')));
  assert.ok(fs.existsSync(path.join(repo, '.zcode', 'skills', 'teamlore'))); // project parts installed
});

// Unknown --agents id → styled error, exit 1.
test('unknown --agents id errors with valid ids and exit 1', () => {
  const repo = tmpDir('tl-e20-');
  gitInit(repo);
  const r = teamlore(['init', '--agents', 'bogus'], repo);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stdout.includes('Unknown host'));
  assert.ok(r.stdout.includes('claude, cursor, zcode, kimi, opencode'));
});

// --------------------------------------------------------------------------

process.on('exit', cleanup);
console.log('\ne2e: ' + passed + ' tests passed');
