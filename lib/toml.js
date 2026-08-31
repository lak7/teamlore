'use strict';

const { isTeamloreScriptCommand } = require('./constants');
const { TextDecoder } = require('util');

/*
 * Minimal line-based editing of `[[hooks]]` stanzas in Kimi Code's
 * ~/.kimi-code/config.toml. No TOML parser: append at EOF, strip by ownership.
 * A sanity scan refuses files that look structurally unsafe (unterminated
 * multi-line strings / unbalanced brackets) or are not valid UTF-8, instead of
 * risking corruption. Strip is key-level: only lines teamlore owns (a command
 * line executing a teamlore script plus, when unambiguous, its paired
 * `event = "UserPromptSubmit"` line) are removed — user keys and comments
 * sharing the stanza survive, and anything ambiguous is left for manual
 * instructions.
 */

function TomlUnsafeError(message) {
  const err = new Error(message);
  err.name = 'TomlUnsafeError';
  return err;
}

// config.toml is only ever edited as UTF-8 text. Decoding another encoding
// (e.g. CP1256) would transcode the user's bytes to U+FFFD — unrecoverable —
// so non-UTF-8 files are refused BEFORE any read/modify/write. A UTF-8 BOM is
// valid UTF-8 and keeps passing.
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
function assertValidUtf8(buffer) {
  try {
    utf8Strict.decode(buffer);
  } catch (_) {
    throw TomlUnsafeError(
      'config.toml is not valid UTF-8 — refusing to modify it (decoding would permanently replace the original bytes).'
    );
  }
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

// Hook fields teamlore recognizes as potentially its own when deciding
// whether a [[hooks]] stanza is wholly ours. Anything else (priority,
// timeout_ms, …) is user-owned and must survive the strip.
const HOOK_KEYS = new Set(['event', 'command', 'timeout', 'matcher']);
const TEAMLORE_EVENT = 'UserPromptSubmit'; // the only event teamlore writes

// Parse a `key = "value"` line (double-quoted basic string). Returns
// { key, value } with the RAW (still escaped) value, else null. Comments and
// exotic lines do not parse — the caller treats them as user-owned.
function parseKeyLine(trimmed) {
  const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/);
  return m ? { key: m[1], value: m[2] } : null;
}

// Classify the body of one [[hooks]] stanza (lines AFTER the header).
// Returns:
//   { mode: 'whole' } — a teamlore command is present and every key is a
//                       recognized hook field: the stanza is entirely ours.
//   { mode: 'pair', cmdIdx, eventIdx } — a teamlore command shares the stanza
//                       with user-owned content, and our command line plus our
//                       `event = "UserPromptSubmit"` line can be identified
//                       unambiguously: drop exactly those two lines.
//   'manual'        — a teamlore command is present but the owned lines
//                       cannot be identified unambiguously: touch nothing,
//                       the caller surfaces manual instructions.
//   null            — no teamlore command: not ours, never touched (a comment
//                       merely mentioning the marker path is not ownership).
function classifyStanza(lines) {
  let cmdIdx = -1;
  let eventIdx = -1;
  let eventOurs = false;
  let foreign = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue; // blank lines carry no ownership either way
    const kv = parseKeyLine(trimmed);
    if (!kv) {
      foreign = true; // comment or exotic line — user-owned
    } else if (kv.key === 'command') {
      if (isTeamloreScriptCommand(kv.value)) {
        if (cmdIdx >= 0) return 'manual'; // two teamlore commands — ambiguous
        cmdIdx = i;
      } else {
        foreign = true; // someone else's command
      }
    } else if (kv.key === 'event') {
      if (eventIdx >= 0) return 'manual';
      eventIdx = i;
      eventOurs = kv.value === TEAMLORE_EVENT;
    } else if (!HOOK_KEYS.has(kv.key)) {
      foreign = true; // priority, timeout_ms, … — user-owned
    }
  }
  if (cmdIdx < 0) return null;
  if (!foreign) return { mode: 'whole' };
  if (eventIdx >= 0 && eventOurs) return { mode: 'pair', cmdIdx, eventIdx };
  return 'manual';
}

// True when any existing [[hooks]] stanza already carries a teamlore command
// (anchored-script ownership — a marker mention in a comment does not count).
function hasTeamloreStanzas(text) {
  const lines = text.split('\n');
  return stanzaRanges(text).some((r) => {
    for (let i = r.start + 1; i < r.end; i++) {
      const kv = parseKeyLine(lines[i].trim());
      if (kv && kv.key === 'command' && isTeamloreScriptCommand(kv.value)) return true;
    }
    return false;
  });
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

// Remove teamlore-owned lines from every [[hooks]] stanza:
//   - a stanza that is entirely teamlore's (only recognized hook fields) is
//     dropped whole;
//   - a stanza sharing space with user-owned keys/comments loses only its
//     teamlore `command` line plus the paired `event = "UserPromptSubmit"`
//     line, keeping every user byte;
//   - anything ambiguous is left untouched and reported for manual removal —
//     when in doubt, don't strip.
// Every other byte (comments, unrelated stanzas, trailing tables) is
// preserved untouched. Returns { text, removed, partial, manual } —
// `removed` counts fully stripped stanzas, `partial` counts stanzas where
// only the owned pair was removed, `manual` lists the verbatim stanzas the
// caller must surface as manual instructions.
function stripHookStanzas(text) {
  const lines = text.split('\n');
  const drop = new Set();
  let removed = 0;
  let partial = 0;
  const manual = [];
  for (const range of stanzaRanges(text)) {
    let end = range.end;
    // A final '' element is the artifact of the file's trailing newline —
    // it belongs to the file, not to the stanza.
    if (end === lines.length && lines[end - 1] === '' && end - 1 > range.start) end--;
    const body = lines.slice(range.start, end);
    const cls = classifyStanza(body.slice(1)); // the [[hooks]] header is never content
    if (!cls) continue;
    if (cls === 'manual') {
      manual.push(body.join('\n'));
      continue;
    }
    if (cls.mode === 'whole') {
      removed++;
      for (let i = range.start; i < end; i++) drop.add(i);
    } else {
      partial++;
      drop.add(range.start + 1 + cls.cmdIdx);
      drop.add(range.start + 1 + cls.eventIdx);
    }
  }
  if (!removed && !partial) return { text, removed: 0, partial: 0, manual };
  const kept = lines.filter((_, i) => !drop.has(i));
  return { text: kept.join('\n'), removed, partial, manual };
}

module.exports = {
  TomlUnsafeError,
  assertSafe,
  assertValidUtf8,
  appendHookStanzas,
  hasTeamloreStanzas,
  stripHookStanzas,
};
