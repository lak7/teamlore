// teamlore plugin for OpenCode (ESM, zero-dep, runs under OpenCode's Bun runtime).
// OpenCode loads .opencode/plugins/*.js at startup and calls the exported async
// factory with { project, client, $, directory, worktree }. v1 uses only
// documented-stable surfaces, no experimental.* hooks:
//   - "chat.message" (per user message): runs the committed recall.js; the first
//     call of a session also runs session mode (the SessionStart digest —
//     OpenCode has no session-start injection channel without experimental APIs).
//   - Stop-equivalent: OpenCode has no Stop injection channel, so when the
//     .needs-distill sentinel exists, distill-check.js runs on the NEXT user
//     message and its nudge is pushed as a second synthetic part (honest,
//     one-message-late delivery; the script clears the sentinel, so the nudge
//     fires at most once per trigger).
//   - "event" (session.idle): log-only, reserved — no injection channel at idle.
// The plugin never reads .lore content itself — it delegates to the committed
// node scripts (single brain across hosts). Every failure path returns silently.

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPTS = '.claude/skills/teamlore/scripts';

function repoRoot(dir) {
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
    }).trim();
    return top || dir;
  } catch (_) {
    return dir;
  }
}

// Run a teamlore hook script, return its claude-envelope additionalContext.
function recallContext(root, script, args, payload) {
  try {
    const res = spawnSync('node', [path.join(root, SCRIPTS, script), ...args], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });
    const out = JSON.parse(res.stdout || '{}');
    return (out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || null;
  } catch (_) {
    return null; // fail open
  }
}

// Per-session first-call memo (same tmp-state pattern as recall.js's dedupe).
function memoFile(sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^\w.-]/g, '_');
  return path.join(os.tmpdir(), `teamlore-opencode-${safe}-session.txt`);
}

export const teamlore = async ({ client, directory }) => {
  const log = (...msg) => {
    try {
      if (client && client.app && client.app.log) {
        client.app.log({ level: 'info', message: msg.join(' '), service: 'teamlore' });
      }
    } catch (_) { /* logging must never throw */ }
  };

  return {
    'chat.message': async (input, output) => {
      try {
        const root = repoRoot(directory || process.cwd());
        // Existence probes only — lore content always stays with the scripts.
        if (!fs.existsSync(path.join(root, SCRIPTS, 'recall.js'))) return;
        if (!fs.existsSync(path.join(root, '.lore'))) return;
        output.parts = output.parts || [];
        const prompt = output.parts
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n');
        const sessionId = input && input.sessionID;
        const memo = memoFile(sessionId);
        if (!fs.existsSync(memo)) {
          try { fs.writeFileSync(memo, new Date().toISOString() + '\n'); } catch (_) {}
          const digest = recallContext(root, 'recall.js', ['session'], {
            cwd: root, session_id: sessionId, hook_event_name: 'SessionStart',
          });
          if (digest) output.parts.push({ type: 'text', synthetic: true, text: digest });
        }
        const context = recallContext(root, 'recall.js', ['prompt'], {
          cwd: root, session_id: sessionId, prompt, hook_event_name: 'UserPromptSubmit',
        });
        if (context) output.parts.push({ type: 'text', synthetic: true, text: context });
        // Stop-equivalent: delivered on the next message after a trigger fired.
        if (fs.existsSync(path.join(root, '.claude/skills/teamlore/.needs-distill'))) {
          const nudge = recallContext(root, 'distill-check.js', [], { cwd: root });
          if (nudge) output.parts.push({ type: 'text', synthetic: true, text: nudge });
        }
      } catch (_) {
        /* fail open: never break the user's session */
      }
    },
    event: async ({ event }) => {
      // Reserved: session.idle carries no injection channel in OpenCode (yet).
      if (event && event.type === 'session.idle') {
        log('session.idle', (event.properties && event.properties.sessionID) || '');
      }
    },
  };
};
