'use strict';

const { HOOK_MARKER } = require('./constants');

/*
 * Minimal line-based editing of `[[hooks]]` stanzas in Kimi Code's
 * ~/.kimi-code/config.toml. No TOML parser: append at EOF, strip by marker.
 * A sanity scan refuses files that look structurally unsafe (unterminated
 * multi-line strings / unbalanced brackets) instead of risking corruption.
 */

function TomlUnsafeError(message) {
  const err = new Error(message);
  err.name = 'TomlUnsafeError';
  return err;
}

// Heuristic safety scan: multi-line `"""`/`'''` strings must be closed and
// square brackets must balance outside multi-line strings and comments.
// A comment or exotic value can trip the bracket count — a false alarm is
// the safe direction (manual fallback instead of a risky write).
function assertSafe(text) {
  let mlString = null;
  let brackets = 0;
  for (const line of text.split('\n')) {
    if (mlString) {
      if (line.includes(mlString)) mlString = null;
      continue;
    }
    for (const delim of ['"""', "'''"]) {
      const count = line.split(delim).length - 1;
      if (count % 2 === 1) mlString = delim; // opened, not closed on this line
    }
    if (/^\s*#/.test(line)) continue; // comments may hold unbalanced brackets
    for (const ch of line) {
      if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
    }
    if (brackets < 0) break;
  }
  if (mlString || brackets !== 0) {
    throw TomlUnsafeError(
      'config.toml looks structurally unsafe to edit ' +
        (mlString ? '(unterminated ' + mlString + ' string)' : '(unbalanced [ ] brackets)') +
        ' — refusing to modify it.'
    );
  }
}

function escapeTomlBasic(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// Ranges (line indexes) of every [[hooks]] stanza: from a `[[hooks]]` header
// line to the next `[`-header line (any table / array-of-tables header ends
// the stanza), or EOF.
function stanzaRanges(text) {
  const lines = text.split('\n');
  const ranges = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (start >= 0 && t.startsWith('[')) {
      ranges.push({ start, end: i });
      start = -1;
    }
    if (start < 0 && t.startsWith('[[hooks]]')) start = i;
  }
  if (start >= 0) ranges.push({ start, end: lines.length });
  return ranges;
}

// True when any existing [[hooks]] stanza already carries a teamlore command.
function hasTeamloreStanzas(text) {
  return stanzaRanges(text).some((r) => text.split('\n').slice(r.start, r.end).join('\n').includes(HOOK_MARKER));
}

// Append `[[hooks]]` stanzas ([{ event, command }]) at EOF. The text is only
// ensured to end with a newline (appending mid-file is never attempted), so
// stripping teamlore stanzas later restores the original bytes exactly.
// Throws TomlUnsafeError without producing a partial write.
function appendHookStanzas(text, stanzas) {
  assertSafe(text);
  let out = text;
  if (out && !out.endsWith('\n')) out += '\n';
  for (const { event, command } of stanzas) {
    out +=
      '[[hooks]]\n' +
      'event = "' + escapeTomlBasic(event) + '"\n' +
      'command = "' + escapeTomlBasic(command) + '"\n';
  }
  return out;
}

// Remove every [[hooks]] stanza containing HOOK_MARKER. Every other byte
// (comments, unrelated stanzas, trailing tables) is preserved untouched.
// Returns { text, removed } — removed counts the stripped stanzas.
function stripHookStanzas(text) {
  const lines = text.split('\n');
  const drop = new Set();
  let removed = 0;
  for (const range of stanzaRanges(text)) {
    let end = range.end;
    // A final '' element is the artifact of the file's trailing newline —
    // it belongs to the file, not to the stanza.
    if (end === lines.length && lines[end - 1] === '' && end - 1 > range.start) end--;
    if (lines.slice(range.start, end).join('\n').includes(HOOK_MARKER)) {
      removed++;
      for (let i = range.start; i < end; i++) drop.add(i);
    }
  }
  if (!removed) return { text, removed: 0 };
  const kept = lines.filter((_, i) => !drop.has(i));
  return { text: kept.join('\n'), removed };
}

module.exports = {
  TomlUnsafeError,
  assertSafe,
  appendHookStanzas,
  hasTeamloreStanzas,
  stripHookStanzas,
};
