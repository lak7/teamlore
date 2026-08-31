#!/usr/bin/env node
/*
 * teamlore T-2 hook-script payload matrix (plain node assert, no frameworks).
 *
 * Spawns `node <script>` with piped stdin against temp fixture repos and asserts
 * the per-host envelopes from the mission payload matrix (§6):
 *   - claude  {cwd, session_id, prompt, hook_event_name} -> hookSpecificOutput
 *   - cursor  {workspace_roots:[root], sessionStart}     -> {"additional_context"}
 *             {stop, status, loop_count}                 -> {"followup_message"} once
 *   - zcode   claude-shaped payloads                     -> hookSpecificOutput;
 *             non-teamlore repo                          -> silent exit 0
 *   - kimi    {UserPromptSubmit, prompt}                 -> plain text (no JSON);
 *             {SessionStart}                             -> silent (not wired)
 *   - all hosts: no .lore -> silent exit 0; malformed JSON -> silent exit 0
 *   - T-2.7 claude byte-identity: v0.2.3 scripts (git show pinned V023_REF) vs working tree
 *     on identical fixtures — byte-equal stdout + equal exit codes
 *   - T-2.8 per-session dedupe: repeat prompts stay silent
 *   - T-3 OpenCode plugin: dynamic-import a tmp .mjs copy with stubbed context
 *
 * Windows-safe: path.join everywhere, no shell-isms, git via arg lists.
 */
'use strict';

const assert = require('assert');
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const RECALL = path.join(REPO, 'templates', 'skill', 'scripts', 'recall.js');
const DISTILL = path.join(REPO, 'templates', 'skill', 'scripts', 'distill-check.js');
const PLUGIN = path.join(REPO, 'templates', 'opencode', 'teamlore.js');
const HEAD = execSync('git rev-parse HEAD', { cwd: REPO, encoding: 'utf8' }).trim();

// v0.2.3 baseline for the T-2.7 byte-identity regression: pinned to the
// upstream commit this branch forked from. Comparing against HEAD would be
// vacuous once this branch is committed, so when the pinned object is not
// available (e.g. a shallow clone) the section SKIPS instead of passing
// without proving anything.
const V023_REF = '75fa052';
const HAS_V023 = (() => {
  try {
    execSync('git cat-file -e ' + V023_REF + '^{commit}', { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
})();

const LORE_NAME = '2026-01-01-webhook-idempotency.md';
const LORE_CONTENT = [
  '---',
  'paths: [src/payments/**]',
  'kind: gotcha',
  'by: teamlore-test',
  'commit: abc123',
  'verify_by: 2026-12-31',
  '---',
  'Stripe webhook handler must be idempotent - retries caused double refunds.',
  'Use the processed_events table instead of in-memory dedupe.',
  '',
].join('\n');

// ---- helpers --------------------------------------------------------------

let counter = 0;
function sid(tag) {
  counter++;
  return 't2-' + tag + '-' + Date.now() + '-' + counter;
}

// Shell-free git invocation (no quoting issues on Windows).
function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error('git ' + args.join(' ') + ' failed: ' + String(res.stderr || res.stdout || ''));
  }
  return String(res.stdout || '');
}

function mkRepo(withLore) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamlore-t2-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'teamlore@test.local'], dir);
  git(['config', 'user.name', 'teamlore-test'], dir);
  if (withLore) {
    fs.mkdirSync(path.join(dir, 'src', 'payments'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'payments', 'refund.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(dir, '.lore'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.lore', LORE_NAME), LORE_CONTENT);
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', 'fixture: lore + code'], dir);
  }
  return dir;
}

function sentinelPath(repo) {
  return path.join(repo, '.claude', 'skills', 'teamlore', '.needs-distill');
}

// Installs the committed skill scripts into a fixture (the OpenCode plugin
// delegates to the installed skill copy, as it would in a real repo).
function installSkill(repo) {
  const target = path.join(repo, '.claude', 'skills', 'teamlore', 'scripts');
  fs.mkdirSync(target, { recursive: true });
  for (const f of ['recall.js', 'distill-check.js', 'distill.md']) {
    fs.copyFileSync(path.join(REPO, 'templates', 'skill', 'scripts', f), path.join(target, f));
  }
}

function writeSentinel(repo) {
  fs.mkdirSync(path.join(repo, '.claude', 'skills', 'teamlore'), { recursive: true });
  fs.writeFileSync(sentinelPath(repo), new Date().toISOString());
}

function stageLore(repo) {
  fs.writeFileSync(
    path.join(repo, '.lore', '2026-02-02-staged-lesson.md'),
    LORE_CONTENT
  );
  git(['add', '.lore/2026-02-02-staged-lesson.md'], repo);
}

// Deterministic root resolution: the fallback env vars must not leak into tests.
function sanitizedEnv() {
  const env = Object.assign({}, process.env);
  delete env.CURSOR_PROJECT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  return env;
}

// Spawns `node <script> <args>` with a JSON payload on stdin; stdout is a Buffer.
function runScript(script, args, payload, opts) {
  const res = spawnSync('node', [script].concat(args), {
    input: payload === undefined ? '' : JSON.stringify(payload),
    cwd: (opts && opts.cwd) || REPO,
    env: sanitizedEnv(),
  });
  return {
    out: res.stdout || Buffer.from(''),
    status: res.status,
    stderr: String(res.stderr || ''),
  };
}

function stateFileFor(sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^\w.-]/g, '_');
  return path.join(os.tmpdir(), 'teamlore-' + safe + '-injected.txt');
}

function pluginMemoFor(sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^\w.-]/g, '_');
  return path.join(os.tmpdir(), 'teamlore-opencode-' + safe + '-session.txt');
}

function clearTmpState(sessionId) {
  // sessionId may be undefined (payload without session_id) -> recall.js keys
  // its dedupe state file under 'nosession'; clear both variants.
  for (const id of [sessionId, null]) {
    for (const f of [stateFileFor(id), pluginMemoFor(id)]) {
      try { fs.unlinkSync(f); } catch (_) { /* absent is fine */ }
    }
  }
}

function parseEnvelope(buf) {
  return JSON.parse(buf.toString('utf8'));
}

// ---- runner ---------------------------------------------------------------

let failures = 0;
const t0 = Date.now();

function section(name, fn) {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (err) {
    failures++;
    console.error('FAIL ' + name + '\n  ' + (err && err.message));
  }
}

async function sectionAsync(name, fn) {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (err) {
    failures++;
    console.error('FAIL ' + name + '\n  ' + (err && err.message));
  }
}

async function main() {
  const loreRepo = mkRepo(true);
  const plainRepo = mkRepo(false);
  const HOSTS = ['claude', 'cursor', 'zcode', 'kimi', 'opencode'];

  // ---- T-2.1 claude envelopes ---------------------------------------------
  section('claude sessionStart -> hookSpecificOutput', () => {
    const s = sid('claude-session');
    const r = runScript(RECALL, ['session'],
      { cwd: loreRepo, session_id: s, hook_event_name: 'SessionStart', source: 'startup' });
    assert.strictEqual(r.status, 0, 'exit 0, stderr: ' + r.stderr);
    const env = parseEnvelope(r.out).hookSpecificOutput;
    assert.strictEqual(env.hookEventName, 'SessionStart');
    assert.ok(env.additionalContext.includes('TEAMLORE RECALL'));
    assert.ok(env.additionalContext.includes(LORE_NAME));
  });

  section('claude UserPromptSubmit -> hookSpecificOutput', () => {
    const s = sid('claude-prompt');
    const r = runScript(RECALL, ['prompt'],
      { cwd: loreRepo, session_id: s, prompt: 'continue with the stripe src/payments refund flow',
        hook_event_name: 'UserPromptSubmit' });
    assert.strictEqual(r.status, 0, 'exit 0, stderr: ' + r.stderr);
    const env = parseEnvelope(r.out).hookSpecificOutput;
    assert.strictEqual(env.hookEventName, 'UserPromptSubmit');
    assert.ok(env.additionalContext.includes('TEAMLORE RECALL'));
  });

  section('claude Stop + sentinel -> nudge once, sentinel cleared', () => {
    const repo = mkRepo(true);
    writeSentinel(repo);
    const r = runScript(DISTILL, [], { cwd: repo, hook_event_name: 'Stop' });
    assert.strictEqual(r.status, 0, 'exit 0, stderr: ' + r.stderr);
    const env = parseEnvelope(r.out).hookSpecificOutput;
    assert.strictEqual(env.hookEventName, 'Stop');
    assert.ok(env.additionalContext.includes('TEAMLORE'));
    assert.ok(env.additionalContext.includes('.claude/skills/teamlore/scripts/distill.md'));
    assert.ok(!fs.existsSync(sentinelPath(repo)), 'sentinel cleared');
  });

  section('claude stop_hook_active:true -> silent, guard kept', () => {
    const repo = mkRepo(true);
    writeSentinel(repo);
    const r = runScript(DISTILL, [], { cwd: repo, stop_hook_active: true, hook_event_name: 'Stop' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out.length, 0);
    assert.ok(fs.existsSync(sentinelPath(repo)), 'guard returns before sentinel logic');
  });

  section('claude staged lore -> silent, sentinel cleared', () => {
    const repo = mkRepo(true);
    writeSentinel(repo);
    stageLore(repo);
    const r = runScript(DISTILL, [], { cwd: repo, hook_event_name: 'Stop' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out.length, 0);
    assert.ok(!fs.existsSync(sentinelPath(repo)));
  });

  // ---- T-2.2 cursor --------------------------------------------------------
  section('cursor sessionStart -> additional_context JSON', () => {
    const s = sid('cursor-session');
    const r = runScript(RECALL, ['session', '--host', 'cursor'],
      { workspace_roots: [loreRepo], hook_event_name: 'sessionStart', session_id: s,
        conversation_id: 'conv1', cursor_version: '1.7.2' });
    assert.strictEqual(r.status, 0, 'exit 0, stderr: ' + r.stderr);
    const env = parseEnvelope(r.out);
    assert.ok(env.additional_context.includes('TEAMLORE RECALL'));
    assert.strictEqual(env.hookSpecificOutput, undefined, 'no claude wrapper');
  });

  section('cursor --host flag accepted before mode', () => {
    const s = sid('cursor-order');
    const r = runScript(RECALL, ['--host', 'cursor', 'session'],
      { workspace_roots: [loreRepo], hook_event_name: 'sessionStart', session_id: s });
    assert.strictEqual(r.status, 0);
    assert.ok(parseEnvelope(r.out).additional_context.includes('TEAMLORE RECALL'));
  });

  section('cursor stop -> followup_message once (second run silent)', () => {
    const repo = mkRepo(true);
    writeSentinel(repo); // cursor shares the claude skill dir sentinel
    const payload = { hook_event_name: 'stop', status: 'completed', loop_count: 0 };
    const r1 = runScript(DISTILL, ['--host', 'cursor'], payload, { cwd: repo });
    assert.strictEqual(r1.status, 0, 'exit 0, stderr: ' + r1.stderr);
    const env = parseEnvelope(r1.out);
    assert.ok(env.followup_message.includes('TEAMLORE'));
    assert.strictEqual(env.hookSpecificOutput, undefined, 'no claude wrapper');
    const r2 = runScript(DISTILL, ['--host', 'cursor'], payload, { cwd: repo });
    assert.strictEqual(r2.status, 0);
    assert.strictEqual(r2.out.length, 0, 'sentinel cleared -> silent');
  });

  // ---- T-2.3 zcode ---------------------------------------------------------
  section('zcode SessionStart (claude-shaped) -> hookSpecificOutput', () => {
    const s = sid('zcode-session');
    const r = runScript(RECALL, ['session', '--host', 'zcode'],
      { cwd: loreRepo, session_id: s, hook_event_name: 'SessionStart', source: 'startup' });
    assert.strictEqual(r.status, 0);
    const env = parseEnvelope(r.out).hookSpecificOutput;
    assert.strictEqual(env.hookEventName, 'SessionStart');
    assert.ok(env.additionalContext.includes('TEAMLORE RECALL'));
  });

  section('zcode UserPromptSubmit -> hookSpecificOutput', () => {
    const s = sid('zcode-prompt');
    const r = runScript(RECALL, ['prompt', '--host', 'zcode'],
      { cwd: loreRepo, session_id: s, prompt: 'work on src/payments refunds',
        hook_event_name: 'UserPromptSubmit' });
    assert.strictEqual(r.status, 0);
    const env = parseEnvelope(r.out).hookSpecificOutput;
    assert.strictEqual(env.hookEventName, 'UserPromptSubmit');
    assert.ok(env.additionalContext.includes('TEAMLORE RECALL'));
  });

  section('zcode machine-global guard: non-teamlore repo -> silent exit 0', () => {
    const s = sid('zcode-plain');
    const r = runScript(RECALL, ['session', '--host', 'zcode'],
      { cwd: plainRepo, session_id: s, hook_event_name: 'SessionStart' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out.length, 0);
  });

  // ---- T-2.4 kimi ----------------------------------------------------------
  section('kimi UserPromptSubmit -> plain text, no JSON', () => {
    const s = sid('kimi-prompt');
    const r = runScript(RECALL, ['prompt', '--host', 'kimi'],
      { cwd: loreRepo, session_id: s, hook_event_name: 'UserPromptSubmit',
        prompt: 'touching src/payments again' });
    assert.strictEqual(r.status, 0);
    const text = r.out.toString('utf8');
    assert.ok(text.startsWith('TEAMLORE RECALL'), 'plain text output');
    assert.throws(() => JSON.parse(text), SyntaxError, 'must not be JSON');
  });

  section('kimi SessionStart (unwired) -> silent exit 0', () => {
    const r = runScript(RECALL, ['session', '--host', 'kimi'],
      { hook_event_name: 'SessionStart', source: 'startup' }, { cwd: plainRepo });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.out.length, 0);
  });

  section('kimi session-mode fallback in lore repo -> plain text (contract 2c)', () => {
    const s = sid('kimi-session');
    const r = runScript(RECALL, ['session', '--host', 'kimi'],
      { cwd: loreRepo, session_id: s, hook_event_name: 'SessionStart', source: 'startup' });
    assert.strictEqual(r.status, 0);
    const text = r.out.toString('utf8');
    assert.ok(text.startsWith('TEAMLORE RECALL'));
    assert.throws(() => JSON.parse(text), SyntaxError);
  });

  // ---- T-2.5 opencode host -------------------------------------------------
  section('opencode host -> same envelope as claude', () => {
    const s = sid('opencode-prompt');
    const r = runScript(RECALL, ['prompt', '--host', 'opencode'],
      { cwd: loreRepo, session_id: s, prompt: 'src/payments refund work',
        hook_event_name: 'UserPromptSubmit' });
    assert.strictEqual(r.status, 0);
    const env = parseEnvelope(r.out).hookSpecificOutput;
    assert.strictEqual(env.hookEventName, 'UserPromptSubmit');
    assert.ok(env.additionalContext.includes('TEAMLORE RECALL'));
  });

  // ---- T-2.6 all hosts: no .lore -> silent; malformed JSON -> silent -------
  section('all hosts: no .lore repo -> silent exit 0', () => {
    for (const host of HOSTS) {
      for (const mode of ['session', 'prompt']) {
        const payload = host === 'cursor'
          ? { workspace_roots: [plainRepo], hook_event_name: 'sessionStart', session_id: sid('nolore') }
          : { cwd: plainRepo, session_id: sid('nolore'), hook_event_name: 'UserPromptSubmit' };
        const r = runScript(RECALL, [mode, '--host', host], payload);
        assert.strictEqual(r.status, 0, host + ' ' + mode + ' exit 0');
        assert.strictEqual(r.out.length, 0, host + ' ' + mode + ' silent');
      }
      const d = runScript(DISTILL, ['--host', host], { cwd: plainRepo }, { cwd: plainRepo });
      assert.strictEqual(d.status, 0, host + ' distill exit 0');
      assert.strictEqual(d.out.length, 0, host + ' distill silent');
    }
  });

  section('all hosts: malformed / empty JSON stdin -> silent exit 0', () => {
    for (const host of HOSTS) {
      const malformed = spawnSync('node', [RECALL, 'session', '--host', host], {
        input: 'NOT-JSON{{{',
        cwd: plainRepo,
        env: sanitizedEnv(),
      });
      assert.strictEqual(malformed.status, 0, host + ' recall exit 0');
      assert.strictEqual((malformed.stdout || Buffer.from('')).length, 0, host + ' recall silent');
      const empty = spawnSync('node', [DISTILL, '--host', host], {
        input: '',
        cwd: plainRepo,
        env: sanitizedEnv(),
      });
      assert.strictEqual(empty.status, 0, host + ' distill exit 0');
      assert.strictEqual((empty.stdout || Buffer.from('')).length, 0, host + ' distill silent');
    }
  });

  // ---- T-2.8 dedupe within one session -------------------------------------
  section('T-2.8 dedupe: repeat prompt within one session_id stays silent', () => {
    const s = sid('dedupe');
    const payload = { cwd: loreRepo, session_id: s, prompt: 'more src/payments refund work',
      hook_event_name: 'UserPromptSubmit' };
    const r1 = runScript(RECALL, ['prompt'], payload);
    assert.strictEqual(r1.status, 0);
    assert.ok(parseEnvelope(r1.out).hookSpecificOutput.additionalContext.includes('TEAMLORE'));
    const r2 = runScript(RECALL, ['prompt'], payload);
    assert.strictEqual(r2.status, 0);
    assert.strictEqual(r2.out.length, 0, 'no repeat within the same session');
    clearTmpState(s);
  });

  // ---- T-2.7 claude byte-identity regression -------------------------------
  await sectionAsync('T-2.7 claude runtime byte-identity vs v0.2.3 (ref ' + V023_REF + ')', async () => {
    if (!HAS_V023) {
      console.log('SKIP: pinned v0.2.3 ref ' + V023_REF + ' not present (shallow clone?) — byte-identity not re-proven here');
      return;
    }
    const v023Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamlore-v023-'));
    const oldRecall = path.join(v023Dir, 'recall.js');
    const oldDistill = path.join(v023Dir, 'distill-check.js');
    fs.writeFileSync(oldRecall,
      execSync('git show ' + V023_REF + ':templates/skill/scripts/recall.js', { cwd: REPO, encoding: 'buffer' }));
    fs.writeFileSync(oldDistill,
      execSync('git show ' + V023_REF + ':templates/skill/scripts/distill-check.js', { cwd: REPO, encoding: 'buffer' }));
    assert.ok(fs.readFileSync(oldRecall).includes('hookSpecificOutput'), 'v0.2.3 fixture extracted');

    // Dedicated repos: mutations (sentinel clear, git add) here must not leak
    // into other sections. Each case runs the v0.2.3 script, restores exactly
    // the state a run mutates, then runs the new script on byte-identical stdin.
    const biRepo = mkRepo(true);
    const ids = {
      session: sid('bi-session'), prompt: sid('bi-prompt'),
      plain: sid('bi-plain'), empty: sid('bi-empty'), bad: sid('bi-bad'),
    };
    const stopInput = (extra) => JSON.stringify(Object.assign({ cwd: biRepo, hook_event_name: 'Stop' }, extra));
    const cases = [
      { name: 'recall/session', script: 'recall', args: ['session'], id: ids.session,
        input: () => JSON.stringify({ cwd: biRepo, session_id: ids.session, hook_event_name: 'SessionStart' }) },
      { name: 'recall/prompt', script: 'recall', args: ['prompt'], id: ids.prompt,
        input: () => JSON.stringify({ cwd: biRepo, session_id: ids.prompt, prompt: 'stripe src/payments refunds',
          hook_event_name: 'UserPromptSubmit' }) },
      { name: 'recall/empty-stdin', script: 'recall', args: [], id: ids.empty,
        input: () => '', spawnCwd: biRepo },
      { name: 'recall/malformed-stdin', script: 'recall', args: ['session'], id: ids.bad, raw: 'NOT-JSON{{{',
        spawnCwd: biRepo },
      { name: 'recall/no-lore-repo', script: 'recall', args: ['session'], id: ids.plain,
        input: () => JSON.stringify({ cwd: plainRepo, session_id: ids.plain, hook_event_name: 'SessionStart' }) },
      { name: 'distill/stop-nudge', script: 'distill', setup: () => writeSentinel(biRepo),
        input: () => stopInput({}) },
      { name: 'distill/stop-hook-active', script: 'distill', setup: () => writeSentinel(biRepo),
        input: () => stopInput({ stop_hook_active: true }) },
      { name: 'distill/staged-lore', script: 'distill',
        setup: () => { stageLore(biRepo); writeSentinel(biRepo); }, input: () => stopInput({}) },
      { name: 'distill/no-sentinel', script: 'distill',
        setup: () => { try { fs.unlinkSync(sentinelPath(biRepo)); } catch (_) {} },
        input: () => stopInput({}) },
    ];

    for (const c of cases) {
      const spawn = (script) => spawnSync('node', [script].concat(c.args || []), {
        input: c.raw !== undefined ? c.raw : c.input(),
        cwd: c.spawnCwd || REPO,
        env: sanitizedEnv(),
      });
      const target = c.script === 'distill' ? DISTILL : RECALL;
      if (c.setup) c.setup(biRepo);
      const oldR = spawn(c.script === 'distill' ? oldDistill : oldRecall);
      clearTmpState(c.id);
      if (c.setup) c.setup(biRepo); // restore state the previous run mutated
      const newR = spawn(target);
      clearTmpState(c.id);
      assert.strictEqual(newR.status, oldR.status,
        c.name + ' exit code (old=' + oldR.status + ' new=' + newR.status + ')');
      assert.deepStrictEqual(newR.stdout || Buffer.from(''), oldR.stdout || Buffer.from(''),
        c.name + ' stdout bytes (Buffer deepStrictEqual is byte-wise)');
    }
    try { git(['reset', '-q'], biRepo); } catch (_) { /* best effort */ }
  });

  // ---- T-3 OpenCode plugin -------------------------------------------------
  await sectionAsync('T-3 OpenCode plugin: synthetic parts, memo, sentinel nudge', async () => {
    const opxSession = sid('opx');
    clearTmpState(opxSession); // fresh memo + dedupe state for this run
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teamlore-opx-'));
    const pluginPath = path.join(tmp, 'teamlore-plugin-test.mjs');
    fs.copyFileSync(PLUGIN, pluginPath);
    const mod = await import(pathToFileURL(pluginPath).href);
    const repo = mkRepo(true);
    installSkill(repo); // plugin delegates to the installed skill copy
    const hooks = await mod.teamlore({
      project: null, client: { app: { log() {} } }, $: null, directory: repo, worktree: repo,
    });
    assert.strictEqual(typeof hooks['chat.message'], 'function');
    assert.strictEqual(typeof hooks.event, 'function');

    // first call: session digest (memo), prompt recall deduped against it
    const out1 = { message: {}, parts: [{ type: 'text', text: 'fix the stripe src/payments refunds' }] };
    await hooks['chat.message']({ sessionID: opxSession }, out1);
    const pushed1 = out1.parts.slice(1);
    assert.strictEqual(pushed1.length, 1, 'exactly one synthetic part (digest), got ' + pushed1.length);
    assert.strictEqual(pushed1[0].type, 'text');
    assert.strictEqual(pushed1[0].synthetic, true);
    assert.ok(pushed1[0].text.includes('TEAMLORE RECALL'));

    // sentinel present -> nudge as a second synthetic part; cleared afterwards
    writeSentinel(repo);
    const out2 = { message: {}, parts: [{ type: 'text', text: 'done, thanks' }] };
    await hooks['chat.message']({ sessionID: opxSession }, out2);
    const pushed2 = out2.parts.slice(1);
    assert.strictEqual(pushed2.length, 1, 'exactly the distill nudge part');
    assert.strictEqual(pushed2[0].synthetic, true);
    assert.ok(pushed2[0].text.includes('distill.md'), 'nudge points at the checklist');
    assert.ok(!fs.existsSync(sentinelPath(repo)), 'sentinel cleared (no infinite nudge)');

    // third call: memo + dedupe + no sentinel -> nothing pushed
    const out3 = { message: {}, parts: [{ type: 'text', text: 'anything else?' }] };
    await hooks['chat.message']({ sessionID: opxSession }, out3);
    assert.strictEqual(out3.parts.length, 1, 'no synthetic parts on third call');

    // session.idle event handler: log-only, must not throw
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: opxSession } } });

    // no .lore repo -> plugin no-ops entirely
    const plain = mkRepo(false);
    const hooksPlain = await mod.teamlore({
      project: null, client: { app: { log() {} } }, $: null, directory: plain, worktree: plain,
    });
    const outP = { message: {}, parts: [{ type: 'text', text: 'src/payments refunds' }] };
    await hooksPlain['chat.message']({ sessionID: opxSession }, outP);
    assert.strictEqual(outP.parts.length, 1, 'no parts pushed without .lore');

    clearTmpState(opxSession); // hygiene
  });

  console.log('\nhooks-matrix: ' + (failures ? failures + ' FAILURE(S)' : 'ALL GREEN') +
    ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
