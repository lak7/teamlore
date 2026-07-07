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
 * The sentinel is always removed after this fires, so the nudge happens at
 * most once per trigger and trivial sessions cost zero tokens.
 *
 * Zero dependencies. Fails open (exit 0 silent) on any error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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

const NUDGE =
  'TEAMLORE: a lore trigger fired this session but no lore file was staged. ' +
  'Run the teamlore distillation checklist (.claude/skills/teamlore/scripts/distill.md): ' +
  'decide whether a durable, team-relevant lesson emerged (a mistake, a non-obvious gotcha, ' +
  'or a decision-with-a-why). If so, write .lore/YYYY-MM-DD-slug.md following the format ' +
  'contract and `git add` it alongside your change — do not commit. ' +
  'If nothing qualifies (task status, personal preference, a secret, or anything reproducible ' +
  'from the code), that is fine: say so briefly and stop.';

function main() {
  const input = parseInput();
  if (input.stop_hook_active === true) return; // loop guard

  const cwd = input.cwd || process.cwd();
  const root = git('rev-parse --show-toplevel', cwd).trim() || cwd;
  const sentinel = path.join(root, '.claude', 'skills', 'teamlore', '.needs-distill');

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

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: NUDGE } })
  );
}

try {
  main();
} catch (_) {
  process.exit(0);
}
