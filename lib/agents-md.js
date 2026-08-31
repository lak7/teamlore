'use strict';

const fs = require('fs');
const path = require('path');
const agents = require('./agents');
const { AGENTS_MD_FILE, AGENTS_MD_START, AGENTS_MD_END } = require('./constants');

/*
 * Marker-guarded AGENTS.md fallback section (mission Appendix A, verbatim).
 * Only appended when at least one non-claude host is selected; strip removes
 * exactly the marker-guarded block and never touches user content.
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

// Append the teamlore section to <root>/AGENTS.md (creating the file if
// needed). Idempotent: a file already containing the start marker is left
// untouched. Returns true when the section was added.
function appendAgentsSection(root) {
  const file = path.join(root, AGENTS_MD_FILE);
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (_) {
    content = '';
  }
  if (content.includes(AGENTS_MD_START)) return false;
  let out = content;
  if (out && !out.endsWith('\n')) out += '\n';
  if (out) out += '\n';
  out += SECTION + '\n';
  agents.writeAtomic(file, out);
  return true;
}

// Remove the marker-guarded section (and only it). If nothing but the
// section remains, the file is deleted — it existed only for teamlore.
// Returns true when the file content (or the file itself) changed.
function stripAgentsSection(root) {
  const file = path.join(root, AGENTS_MD_FILE);
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return false;
  }
  const startIdx = content.indexOf(AGENTS_MD_START);
  if (startIdx === -1) return false;
  const endIdx = content.indexOf(AGENTS_MD_END, startIdx);
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
