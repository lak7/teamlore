'use strict';

/*
 * Unit tests for the cross-host merge/edit helpers (P1).
 * Plain node assert, no frameworks. Run: node test/unit-merge.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agents = require('../lib/agents');
const toml = require('../lib/toml');
const agentsMd = require('../lib/agents-md');
const cursor = require('../lib/adapters/cursor');
const zcode = require('../lib/adapters/zcode');
const { HOOK_MARKER } = require('../lib/constants');

const TEMPLATES = path.join(__dirname, '..', 'templates');
const tmpRoots = [];

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

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok - ' + name);
}

// ---- cursor: hooks.json merge/strip --------------------------------------

const CURSOR_CMD =
  'node ".claude/skills/teamlore/scripts/recall.js" session --host cursor';

test('cursor merge into empty file scaffolds version + both events', () => {
  const res = cursor.mergeCursorHooksText('');
  assert.strictEqual(res.changed, true);
  const doc = JSON.parse(res.text);
  assert.strictEqual(doc.version, 1);
  assert.strictEqual(doc.hooks.sessionStart.length, 1);
  assert.strictEqual(doc.hooks.stop.length, 1);
  assert.ok(doc.hooks.sessionStart[0].command.includes(HOOK_MARKER));
});

test('cursor merge preserves pre-existing unrelated hook (deep-equal)', () => {
  const existing = {
    version: 1,
    hooks: {
      afterFileEdit: [{ command: './hooks/format.sh', timeout: 30 }],
      sessionStart: [{ command: 'node user-own.js' }],
    },
  };
  const res = cursor.mergeCursorHooksText(JSON.stringify(existing, null, 2));
  assert.strictEqual(res.changed, true);
  const doc = JSON.parse(res.text);
  // unrelated hook is preserved byte-exact (same object, same order)
  assert.deepStrictEqual(doc.hooks.afterFileEdit, existing.hooks.afterFileEdit);
  assert.deepStrictEqual(doc.hooks.sessionStart[0], existing.hooks.sessionStart[0]);
  assert.strictEqual(doc.hooks.sessionStart[1].command, CURSOR_CMD);
  assert.strictEqual(doc.version, 1);
});

test('cursor merge is idempotent (no duplicate teamlore entries)', () => {
  const first = cursor.mergeCursorHooksText('');
  const second = cursor.mergeCursorHooksText(first.text);
  assert.strictEqual(second.changed, false);
  assert.strictEqual(second.text, first.text);
});

test('cursor merge refuses unparseable JSON', () => {
  assert.throws(() => cursor.mergeCursorHooksText('{not json'), /refusing to/);
});

test('cursor strip restores unrelated-only content and flags created files', () => {
  const existing = {
    version: 1,
    hooks: {
      afterFileEdit: [{ command: './hooks/format.sh' }],
      sessionStart: [{ command: 'node user-own.js' }],
    },
  };
  const merged = cursor.mergeCursorHooksText(JSON.stringify(existing, null, 2));

  const stripped = cursor.stripCursorHooksText(merged.text);
  assert.strictEqual(stripped.changed, true);
  assert.strictEqual(stripped.removable, false); // user content remains
  const doc = JSON.parse(stripped.text);
  assert.deepStrictEqual(doc, existing); // back to the pre-existing content

  // created-by-teamlore file: after strip only the version scaffold remains
  const created = cursor.mergeCursorHooksText('');
  const strippedCreated = cursor.stripCursorHooksText(created.text);
  assert.strictEqual(strippedCreated.changed, true);
  assert.strictEqual(strippedCreated.removable, true); // caller deletes the file
});

test('cursor strip refuses unparseable JSON', () => {
  assert.throws(() => cursor.stripCursorHooksText('nope'), /leaving it untouched/);
});

// ---- zcode: config.json merge/strip --------------------------------------

test('zcode merge preserves unrelated keys and adds hooks.enabled once', () => {
  const existing = {
    mcp: { servers: { context7: { url: 'https://mcp.example.com' } } },
    theme: 'dark',
  };
  const res = zcode.mergeZcodeConfigText(JSON.stringify(existing, null, 2));
  assert.strictEqual(res.changed, true);
  const doc = JSON.parse(res.text);
  assert.deepStrictEqual(doc.mcp, existing.mcp);
  assert.strictEqual(doc.theme, 'dark');
  assert.strictEqual(doc.hooks.enabled, true); // set once, was absent
  assert.ok(Array.isArray(doc.hooks.events.SessionStart));
  assert.ok(Array.isArray(doc.hooks.events.UserPromptSubmit));
  assert.ok(Array.isArray(doc.hooks.events.Stop));

  // second merge: nothing changes, enabled stays as-is
  const again = zcode.mergeZcodeConfigText(res.text);
  assert.strictEqual(again.changed, false);
  assert.deepStrictEqual(JSON.parse(again.text), doc);
});

test('zcode merge keeps user hooks, never duplicates, respects enabled:false', () => {
  const existing = {
    hooks: {
      enabled: false, // user's explicit choice — never flipped
      events: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node check.mjs' }] }] },
    },
  };
  const res = zcode.mergeZcodeConfigText(JSON.stringify(existing));
  const doc = JSON.parse(res.text);
  assert.strictEqual(doc.hooks.enabled, false);
  assert.strictEqual(res.enabledWarning, true);
  assert.deepStrictEqual(doc.hooks.events.PreToolUse, existing.hooks.events.PreToolUse);
  assert.ok(doc.hooks.events.Stop[0].hooks[0].command.includes(HOOK_MARKER));
});

test('zcode commands are absolute with forward slashes and --host zcode', () => {
  const res = zcode.mergeZcodeConfigText('');
  const doc = JSON.parse(res.text);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const cmd = doc.hooks.events[event][0].hooks[0].command;
    assert.ok(cmd.startsWith('node "'), cmd);
    assert.ok(!cmd.includes('\\'), cmd); // forward slashes only
    assert.ok(cmd.includes('/.zcode/skills/teamlore/scripts/'), cmd);
    assert.ok(cmd.endsWith('--host zcode'), cmd);
    assert.ok(path.isAbsolute(cmd.match(/"([^"]+)"/)[1]), cmd);
  }
});

test('zcode strip removes only teamlore entries; enabled untouched', () => {
  const unrelated = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node lint.js' }] };
  const merged = zcode.mergeZcodeConfigText(
    JSON.stringify({ hooks: { enabled: true, events: { Stop: [unrelated] } } })
  );
  const stripped = zcode.stripZcodeConfigText(merged.text);
  assert.strictEqual(stripped.changed, true);
  const doc = JSON.parse(stripped.text);
  assert.strictEqual(doc.hooks.enabled, true); // never flipped to false
  assert.deepStrictEqual(doc.hooks.events.Stop, [unrelated]);
  assert.ok(!doc.hooks.events.SessionStart);
  assert.ok(!doc.hooks.events.UserPromptSubmit);
  assert.deepStrictEqual(JSON.parse(zcode.stripZcodeConfigText(JSON.stringify({ mcp: {} })).text || '{}').mcp, {});
});

test('zcode strip/file-level helpers refuse unparseable JSON', () => {
  assert.throws(() => zcode.mergeZcodeConfigText('{oops'), /refusing to/);
  assert.throws(() => zcode.stripZcodeConfigText('{oops'), /leaving it untouched/);
});

// ---- kimi: TOML append/strip ---------------------------------------------

const KIMI_STANZA = '[[hooks]]\nevent = "UserPromptSubmit"\ncommand = "';

test('kimi append puts stanzas at EOF; comments and tables preserved', () => {
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
  const appended = toml.appendHookStanzas(original, [
    { event: 'UserPromptSubmit', command: 'node "C:/Users/x/.kimi-code/skills/teamlore/scripts/recall.js" prompt --host kimi' },
  ]);
  assert.ok(appended.startsWith(original)); // every preceding byte preserved
  assert.ok(appended.trimEnd().endsWith('--host kimi"'));
  assert.ok(appended.indexOf(KIMI_STANZA) > appended.indexOf('[provider]')); // EOF

  // strip round-trips byte-identically
  const stripped = toml.stripHookStanzas(appended);
  assert.strictEqual(stripped.removed, 1);
  assert.strictEqual(stripped.text, original);
});

test('kimi append escapes TOML basic strings', () => {
  const out = toml.appendHookStanzas('', [{ event: 'UserPromptSubmit', command: 'a"b\\c' }]);
  assert.ok(out.includes('command = "a\\"b\\\\c"'));
});

test('kimi unsafe TOML is refused (no write, exact error type)', () => {
  const unsafe = 'desc = """\nunterminated\nmodel = "x"\n';
  assert.throws(() => toml.appendHookStanzas(unsafe, [{ event: 'E', command: 'c' }]), (err) => {
    assert.strictEqual(err.name, 'TomlUnsafeError');
    return true;
  });
  assert.throws(() => toml.appendHookStanzas('a = [1, 2\nb = 3\n', [{ event: 'E', command: 'c' }]), /unbalanced/);
  // multiline string that IS closed is fine
  const ok = toml.appendHookStanzas('desc = """\nclosed """\n', [{ event: 'E', command: 'c' }]);
  assert.ok(ok.startsWith('desc = """\nclosed """\n'));
});

test('kimi strip removes only marker stanzas (unrelated stanza + trailing table kept)', () => {
  const text = [
    '[[hooks]]',
    'event = "PreToolUse"',
    'command = "node own.js"',
    '',
    '[[hooks]]',
    'event = "UserPromptSubmit"',
    'command = "node .kimi-code/skills/teamlore/scripts/recall.js"',
    '',
    '[provider]',
    'name = "moonshot"',
    '',
  ].join('\n');
  const stripped = toml.stripHookStanzas(text);
  assert.strictEqual(stripped.removed, 1);
  assert.ok(stripped.text.includes('own.js'));
  assert.ok(stripped.text.includes('[provider]'));
  assert.ok(!stripped.text.includes('teamlore'));
});

// ---- AGENTS.md append/strip ----------------------------------------------

test('AGENTS.md append/strip idempotence + user content preserved', () => {
  const root = tmpDir('tl-agents-');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# My project\n\nBe nice.\n');

  assert.strictEqual(agentsMd.appendAgentsSection(root), true);
  const withSection = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(withSection.startsWith('# My project'));
  assert.ok(withSection.includes('<!-- teamlore:start -->'));
  assert.ok(withSection.includes('<!-- teamlore:end -->'));
  assert.strictEqual(withSection.split('<!-- teamlore:start -->').length - 1, 1);

  // idempotent
  assert.strictEqual(agentsMd.appendAgentsSection(root), false);

  // strip restores user content exactly
  assert.strictEqual(agentsMd.stripAgentsSection(root), true);
  assert.strictEqual(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# My project\n\nBe nice.\n');

  // stripping again is a no-op
  assert.strictEqual(agentsMd.stripAgentsSection(root), false);
});

test('AGENTS.md created for the section is deleted on strip', () => {
  const root = tmpDir('tl-agents2-');
  assert.strictEqual(agentsMd.appendAgentsSection(root), true);
  assert.strictEqual(agentsMd.stripAgentsSection(root), true);
  assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')));
});

// ---- atomic write + skill copy -------------------------------------------

test('writeAtomic creates, overwrites, and leaves no tmp files', () => {
  const dir = tmpDir('tl-atomic-');
  const file = path.join(dir, 'nested', 'config.json');
  agents.writeAtomic(file, '{"a":1}\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
  agents.writeAtomic(file, '{"a":2}\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"a":2}\n');
  const leftovers = fs.readdirSync(path.join(dir, 'nested')).filter((f) => f.includes('.tmp-'));
  assert.strictEqual(leftovers.length, 0);
});

test('copySkill rewrites SKILL.md for zcode, identity for claude family', () => {
  const root = tmpDir('tl-skill-');
  agents.copySkill(path.join(root, '.zcode', 'skills', 'teamlore'), TEMPLATES, '.zcode/skills/teamlore');
  const zSkill = fs.readFileSync(path.join(root, '.zcode', 'skills', 'teamlore', 'SKILL.md'), 'utf8');
  assert.ok(zSkill.includes('.zcode/skills/teamlore/.needs-distill'));
  assert.ok(!zSkill.includes('.claude/skills/teamlore'));
  const templateSkill = fs.readFileSync(path.join(TEMPLATES, 'skill', 'SKILL.md'), 'utf8');
  assert.strictEqual(zSkill, templateSkill.split('.claude/skills/teamlore/').join('.zcode/skills/teamlore/'));

  // scripts are never rewritten
  const zRecall = fs.readFileSync(path.join(root, '.zcode', 'skills', 'teamlore', 'scripts', 'recall.js'), 'utf8');
  assert.strictEqual(zRecall, fs.readFileSync(path.join(TEMPLATES, 'skill', 'scripts', 'recall.js'), 'utf8'));

  // claude-family copy is byte-identical to templates
  agents.copySkill(path.join(root, '.claude', 'skills', 'teamlore'), TEMPLATES, '.claude/skills/teamlore');
  const cSkill = fs.readFileSync(path.join(root, '.claude', 'skills', 'teamlore', 'SKILL.md'), 'utf8');
  assert.strictEqual(cSkill, templateSkill);
});

// --------------------------------------------------------------------------

process.on('exit', cleanup);
console.log('\nunit-merge: ' + passed + ' tests passed');
