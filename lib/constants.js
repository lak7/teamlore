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

// Ownership rule for STRIP paths: a hook command is teamlore-owned only when
// it executes a teamlore script — the marker path AND a recall|distill-check.js
// filename in the path position. A command that merely mentions the path
// (a logger argument, a doc example) is foreign and must never be unwired.
// Init dedupe stays exact-command match (commandExists); this predicate is
// only for remove/strip, where a false positive deletes user data.
function isTeamloreScriptCommand(command) {
  return (
    typeof command === 'string' &&
    command.includes(HOOK_MARKER) &&
    /skills\/teamlore\/scripts\/(recall|distill-check)\.js/.test(command)
  );
}

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

// --- cross-host constants (adapters layer) --------------------------------

// Canonical host ids, in the fixed install/uninstall order.
const HOST_IDS = ['claude', 'cursor', 'zcode', 'kimi', 'opencode'];

// Marker-guarded AGENTS.md fallback section (appended when any non-claude
// host is selected; see lib/agents-md.js).
const AGENTS_MD_FILE = 'AGENTS.md';
const AGENTS_MD_START = '<!-- teamlore:start -->';
const AGENTS_MD_END = '<!-- teamlore:end -->';

// Cursor project artifacts.
const CURSOR_HOOKS_FILE = '.cursor/hooks.json';
const CURSOR_RULE_FILE = '.cursor/rules/teamlore.mdc';

// ZCode artifacts (project skill + user-level config that holds hooks).
const ZCODE_SKILL_DIR = '.zcode/skills/teamlore';
const ZCODE_SENTINEL_FILE = '.zcode/skills/teamlore/.needs-distill';
const ZCODE_CONFIG_FILE = '.zcode/cli/config.json'; // relative to the user home

// Kimi Code artifacts (project skill + user-level TOML config).
const KIMI_SKILL_DIR = '.kimi-code/skills/teamlore';
const KIMI_SENTINEL_FILE = '.kimi-code/skills/teamlore/.needs-distill';
const KIMI_CONFIG_FILE = 'config.toml'; // relative to ~/.kimi-code

// OpenCode in-process plugin (installed from templates/opencode/teamlore.js).
const OPENCODE_PLUGIN_FILE = '.opencode/plugins/teamlore.js';

module.exports = {
  SKILL_DIR,
  SETTINGS_FILE,
  LORE_DIR,
  LOREIGNORE_FILE,
  SENTINEL_FILE,
  HOOK_MARKER,
  isTeamloreScriptCommand,
  HOOKS,
  HOST_IDS,
  AGENTS_MD_FILE,
  AGENTS_MD_START,
  AGENTS_MD_END,
  CURSOR_HOOKS_FILE,
  CURSOR_RULE_FILE,
  ZCODE_SKILL_DIR,
  ZCODE_SENTINEL_FILE,
  ZCODE_CONFIG_FILE,
  KIMI_SKILL_DIR,
  KIMI_SENTINEL_FILE,
  KIMI_CONFIG_FILE,
  OPENCODE_PLUGIN_FILE,
};
