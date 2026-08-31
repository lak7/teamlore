'use strict';

const fs = require('fs');
const path = require('path');
const agents = require('./agents');
const { AGENTS_MD_FILE, AGENTS_MD_START, AGENTS_MD_END } = require('./constants');

/*
 * Marker-guarded AGENTS.md fallback section (mission Appendix A, verbatim).
 * Only appended when at least one non-claude host is selected; strip removes
 * exactly the marker-guarded block and never touches user content.
 *
 * Markers are only REAL when they sit outside a fenced code block (``` or
 * ~~~, 3+ chars, CommonMark style — the opening fence's info string counts as
 * inside the fence). A marker inside a fence is documentation the user wrote
 * about teamlore: install treats it as "no section yet" and strip never
 * deletes or rewrites fenced content.
 */

const SECTION =
  AGENTS_MD_START + '\n' +
  '## teamlore — shared team memory (.lore/)\n' +
  '\n' +
  'This repo keeps team memories in `.lore/` — one small reviewable file per lesson.\n' +
  '- Before editing files, check `.lore/` for entries whose `paths` frontmatter globs match your\n' +
  '  target files; read those entries and follow them. Cite the `.lore/<file>` you acted on.\n' +
  '- When you are corrected, something fails surprisingly, or a decision is settled with a stated\n' +
  '  why: write `.lore/YYYY-MM-DD-slug.md` (frontmatter: `paths`, `kind: mistake|gotcha|decision`,\n' +
  '  `by`, `commit`, `verify_by`; body ≤ 120 words), then `git add` it — never commit; a human\n' +
  '  reviews lore like code.\n' +
  '- Never put secrets or anything matched by `.loreignore` into lore.\n' +
  AGENTS_MD_END;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// One boolean per line of `content`: true when the line belongs to a fenced
// code block. The opening fence line itself is masked too, so a marker in a
// fence info string is ignored. Closing fences must use the same character,
// be at least as long, and carry no info string (CommonMark).
function fencedLines(content) {
  const lines = content.split('\n');
  const mask = new Array(lines.length).fill(false);
  let open = null; // { char, len } of the fence currently open
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FENCE_RE);
    if (open) {
      if (m && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === '') {
        open = null;
      }
      mask[i] = true;
    } else if (m) {
      open = { char: m[1][0], len: m[1].length };
      mask[i] = true;
    }
  }
  return mask;
}

// First index of `needle` at/after `from` sitting on an UNFENCED line, or -1.
function realMarkerIndex(content, needle, from, mask) {
  let idx = from;
  while ((idx = content.indexOf(needle, idx)) !== -1) {
    const line = content.slice(0, idx).split('\n').length - 1;
    if (!mask[line]) return idx;
    idx += needle.length;
  }
  return -1;
}

// Append the teamlore section to <root>/AGENTS.md (creating the file if
// needed). Idempotent: a file already containing a REAL (unfenced) start
// marker is left untouched — fenced examples never suppress the install, the
// section is always appended at EOF, never inside a fence. Returns true when
// the section was added.
function appendAgentsSection(root) {
  const file = path.join(root, AGENTS_MD_FILE);
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (_) {
    content = '';
  }
  if (realMarkerIndex(content, AGENTS_MD_START, 0, fencedLines(content)) !== -1) return false;
  let out = content;
  if (out && !out.endsWith('\n')) out += '\n';
  if (out) out += '\n';
  out += SECTION + '\n';
  agents.writeAtomic(file, out);
  return true;
}

// Remove the marker-guarded section (and only it). Only REAL (unfenced)
// markers can open/close a section — a start marker inside a fence must not
// open one, and fenced content is never deleted. If nothing but the section
// remains, the file is deleted — it existed only for teamlore.
// Returns true when the file content (or the file itself) changed.
function stripAgentsSection(root) {
  const file = path.join(root, AGENTS_MD_FILE);
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return false;
  }
  const mask = fencedLines(content);
  const startIdx = realMarkerIndex(content, AGENTS_MD_START, 0, mask);
  if (startIdx === -1) return false;
  const endIdx = realMarkerIndex(content, AGENTS_MD_END, startIdx + AGENTS_MD_START.length, mask);
  if (endIdx === -1) return false; // malformed markers — leave the file alone
  let kept =
    content.slice(0, startIdx).replace(/\n+$/, '\n') +
    content.slice(endIdx + AGENTS_MD_END.length).replace(/^\n+/, '');
  if (!kept.trim()) {
    fs.rmSync(file, { force: true });
    return true;
  }
  if (kept === content) return false;
  agents.writeAtomic(file, kept);
  return true;
}

module.exports = { appendAgentsSection, stripAgentsSection, SECTION };
