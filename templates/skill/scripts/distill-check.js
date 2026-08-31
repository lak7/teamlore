#!/usr/bin/env node
/*
 * teamlore distill-check — deterministic capture safety net (Stop hook).
 *
 * A Stop hook is a plain command; it cannot run the model's distillation
 * reasoning itself. Capture is driven by the teamlore SKILL during the
 * session: when a write-trigger fires, the agent creates a sentinel file
 * (.claude/skills/teamlore/.needs-distill) and is expected to stage a lore
 * file before ending.
 *
 * This hook is the gate. On Stop:
 *   - if stop_hook_active is true  -> allow stop (loop guard)
 *   - if no sentinel               -> silent (nothing happened worth capturing)
 *   - if lore is already staged    -> clear sentinel, silent (capture done)
 *   - otherwise                    -> nudge the agent to run distill.md, once
 *
 * This hook is the gate. On Stop:
 *   - if stop_hook_active is true  -> allow stop (loop guard)
 *   - if no sentinel               -> silent (nothing happened worth capturing)
 *   - if lore is already staged    -> clear sentinel, silent (capture done)
 *   - otherwise                    -> nudge the agent to run distill.md, once
 *
 * The sentinel is always removed after this fires, so the nudge happens at
 * most once per trigger and trivial sessions cost zero tokens.
 *
 * `--host <id>` (default claude) selects the sentinel path and response
 * envelope: claude/zcode -> {"hookSpecificOutput":{...Stop...}}; cursor ->
 * {"followup_message": nudge}; kimi -> emits nothing (Stop is unwired there —
 * a followup would force a model continuation).
 *
 * Zero dependencies. Fails open (exit 0 silent) on any error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Host registry (frozen contract, mirrored in recall.js). Scripts are
// standalone and cannot require lib/, so this map is embedded as a literal.
const HOSTS = {
  claude:   { skillDir: '.claude/skills/teamlore',    envelope: 'claude'  },
  cursor:   { skillDir: '.claude/skills/teamlore',    envelope: 'cursor'  },
  zcode:    { skillDir: '.zcode/skills/teamlore',     envelope: 'claude'  },
  kimi:     { skillDir: '.kimi-code/skills/teamlore', envelope: 'kimi'    },
  opencode: { skillDir: '.claude/skills/teamlore',    envelope: 'claude'  },
};

// `--host <id>` may appear anywhere in argv; default claude keeps the shipped
// hook commands byte-identical. Unknown ids fall back to claude (fail open).
function parseArgv(argv) {
  let host = 'claude';
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--host' && i + 1 < argv.length) {
      host = HOSTS[argv[i + 1]] ? argv[i + 1] : 'claude';
      i++;
    }
  }
  return { host };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function parseInput() {
  const raw = readStdin();
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function git(args, cwd) {
  try {
    return execSync('git ' + args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
  } catch (_) {
    return '';
  }
}

// The distill.md path is host-relative so every host is nudged toward its own
// skill copy (identity for claude -> byte-identical NUDGE string).
function nudgeText(skillDir) {
  return (
    'TEAMLORE: a lore trigger fired this session but no lore file was staged. ' +
    'Run the teamlore distillation checklist (' + skillDir + '/scripts/distill.md): ' +
    'decide whether a durable, team-relevant lesson emerged (a mistake, a non-obvious gotcha, ' +
    'or a decision-with-a-why). If so, write .lore/YYYY-MM-DD-slug.md following the format ' +
    'contract and `git add` it alongside your change — do not commit. ' +
    'If nothing qualifies (task status, personal preference, a secret, or anything reproducible ' +
    'from the code), that is fine: say so briefly and stop.'
  );
}

function emitNudge(host, text) {
  const envelope = HOSTS[host].envelope;
  if (envelope === 'cursor') {
    // Cursor stop: a non-empty followup_message is auto-submitted as the next
    // user message (terminal by design — the sentinel is already cleared).
    process.stdout.write(JSON.stringify({ followup_message: text }));
  } else if (envelope === 'kimi') {
    // Kimi Stop is unwired: a followup there would force a model continuation.
    return;
  } else {
    // claude / zcode / opencode: identical hookSpecificOutput Stop envelope.
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text } })
    );
  }
}

function main() {
  const { host } = parseArgv(process.argv);
  const input = parseInput();
  if (input.stop_hook_active === true) return; // loop guard

  const cwd = input.cwd || process.cwd();
  const root = git('rev-parse --show-toplevel', cwd).trim() || cwd;
  // Machine-global hooks fire in every repo: no .lore/ -> nothing to gate.
  if (!fs.existsSync(path.join(root, '.lore'))) return;

  const sentinel = path.join(root, HOSTS[host].skillDir, '.needs-distill');

  if (!fs.existsSync(sentinel)) return; // no trigger this session

  // clear the sentinel first so we never nudge twice for the same trigger
  try {
    fs.unlinkSync(sentinel);
  } catch (_) {
    /* ignore */
  }

  // if the agent already staged lore, capture happened — stay silent
  const staged = git('diff --cached --name-only', root)
    .split('\n')
    .map((s) => s.trim());
  const loreStaged = staged.some(
    (f) => f.startsWith('.lore/') && f.endsWith('.md') && !/\/readme\.md$/i.test(f)
  );
  if (loreStaged) return;

  emitNudge(host, nudgeText(HOSTS[host].skillDir));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
