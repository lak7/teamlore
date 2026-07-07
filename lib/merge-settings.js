'use strict';

const fs = require('fs');
const { HOOKS, HOOK_MARKER } = require('./constants');

/*
 * Safely merge teamlore's hooks into a Claude Code settings.json.
 *
 * Guarantees:
 *   - existing (non-teamlore) hooks and every other settings key are preserved
 *   - re-running is idempotent: a teamlore command already present is not re-added
 *   - a malformed/empty file is treated as {} rather than clobbered blindly
 *
 * Returns { changed, settings, added } — `added` lists the event names wired.
 */

function commandExists(settings, command) {
  const events = settings.hooks || {};
  for (const key of Object.keys(events)) {
    const blocks = Array.isArray(events[key]) ? events[key] : [];
    for (const block of blocks) {
      const hooks = block && Array.isArray(block.hooks) ? block.hooks : [];
      if (hooks.some((h) => h && h.command === command)) return true;
    }
  }
  return false;
}

function mergeSettings(existingText) {
  let settings = {};
  if (existingText && existingText.trim()) {
    try {
      const parsed = JSON.parse(existingText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed;
      } else {
        throw new Error('settings.json is not a JSON object');
      }
    } catch (err) {
      // Do not silently overwrite a file we cannot understand.
      throw new Error(
        'Could not parse existing .claude/settings.json as JSON — refusing to ' +
          'overwrite it. Fix or remove the file and re-run. (' + err.message + ')'
      );
    }
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  const added = [];
  for (const [event, { matcher, command }] of Object.entries(HOOKS)) {
    if (commandExists(settings, command)) continue;
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event].push({
      matcher,
      hooks: [{ type: 'command', command }],
    });
    added.push(event);
  }

  return { changed: added.length > 0, settings, added };
}

// Convenience wrapper used by init: read → merge → write only if changed.
function applyToFile(settingsPath) {
  let existing = '';
  try {
    existing = fs.readFileSync(settingsPath, 'utf8');
  } catch (_) {
    existing = '';
  }
  const { changed, settings, added } = mergeSettings(existing);
  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  return { changed, added };
}

// Reverse of mergeSettings: strip every teamlore hook (any command containing
// HOOK_MARKER), collapsing now-empty blocks / event arrays / the hooks object.
// Every other hook and settings key is preserved untouched.
function stripSettings(existingText) {
  let settings;
  try {
    settings = JSON.parse(existingText);
  } catch (err) {
    throw new Error(
      'Could not parse .claude/settings.json as JSON — leaving it untouched. (' +
        err.message + ')'
    );
  }
  if (!settings || typeof settings !== 'object' || !settings.hooks) {
    return { changed: false, settings, removed: [] };
  }

  const removed = [];
  for (const event of Object.keys(settings.hooks)) {
    const blocks = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const kept = [];
    for (const block of blocks) {
      const hooks = block && Array.isArray(block.hooks) ? block.hooks : [];
      const keptHooks = hooks.filter(
        (h) => !(h && typeof h.command === 'string' && h.command.includes(HOOK_MARKER))
      );
      if (keptHooks.length !== hooks.length && !removed.includes(event)) removed.push(event);
      if (keptHooks.length > 0) kept.push({ ...block, hooks: keptHooks });
    }
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  return { changed: removed.length > 0, settings, removed };
}

function stripFromFile(settingsPath) {
  let existing;
  try {
    existing = fs.readFileSync(settingsPath, 'utf8');
  } catch (_) {
    return { changed: false, removed: [] };
  }
  const { changed, settings, removed } = stripSettings(existing);
  if (changed) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  return { changed, removed };
}

module.exports = {
  mergeSettings,
  applyToFile,
  commandExists,
  stripSettings,
  stripFromFile,
};
