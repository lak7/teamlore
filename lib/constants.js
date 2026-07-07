'use strict';

// Paths (relative to a target repo root) that teamlore manages.
const SKILL_DIR = '.claude/skills/teamlore';
const SETTINGS_FILE = '.claude/settings.json';
const LORE_DIR = '.lore';
const LOREIGNORE_FILE = '.loreignore';
const SENTINEL_FILE = '.claude/skills/teamlore/.needs-distill';

// Substring present in every teamlore hook command — used to detect a prior
// install so re-running init never duplicates hooks.
const HOOK_MARKER = 'skills/teamlore/scripts';

// The hook blocks teamlore wires into .claude/settings.json. Commands invoke
// Node directly (cross-platform) against $CLAUDE_PROJECT_DIR-relative scripts.
const HOOKS = {
  SessionStart: {
    matcher: 'startup|resume|clear',
    command:
      'node "$CLAUDE_PROJECT_DIR/.claude/skills/teamlore/scripts/recall.js" session',
  },
  UserPromptSubmit: {
    matcher: '',
    command:
      'node "$CLAUDE_PROJECT_DIR/.claude/skills/teamlore/scripts/recall.js" prompt',
  },
  Stop: {
    matcher: '',
    command:
      'node "$CLAUDE_PROJECT_DIR/.claude/skills/teamlore/scripts/distill-check.js"',
  },
};

module.exports = {
  SKILL_DIR,
  SETTINGS_FILE,
  LORE_DIR,
  LOREIGNORE_FILE,
  SENTINEL_FILE,
  HOOK_MARKER,
  HOOKS,
};
