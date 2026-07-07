#!/usr/bin/env node
/*
 * teamlore recall — path-scoped retrieval of shared team lore.
 *
 * Invoked by two Claude Code hooks (see .claude/settings.json):
 *   node recall.js session       (SessionStart)  broad digest from git-recent files
 *   node recall.js pretooluse     (PreToolUse Edit|Write)  precise per-file recall
 *
 * Reads the hook payload as JSON on stdin, matches `.lore/*.md` frontmatter
 * `paths` globs against the relevant files, and prints
 *   {"hookSpecificOutput":{"hookEventName":..., "additionalContext":"TEAMLORE RECALL ..."}}
 * to stdout. Emits NOTHING when there are no matches (silent empty state).
 *
 * Zero dependencies. Never throws to the hook: any failure exits 0 silently so
 * a broken recall can never block a developer's session.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const MAX_ENTRIES = 5;
const MAX_CHARS = 3200; // ~800 tokens hard cap

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

function repoRoot(cwd) {
  const top = git('rev-parse --show-toplevel', cwd).trim();
  return top || cwd;
}

// ---- glob matching -------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Supports **, *, ?, and {a,b} alternation. `**` crosses directory
// separators; `*` and `?` stay within a path segment.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // collapse `**/` so `a/**` also matches `a/x`
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const j = glob.indexOf('}', i);
      if (j === -1) {
        re += '\\{';
      } else {
        const inner = glob
          .slice(i + 1, j)
          .split(',')
          .map((s) => escapeRe(s.trim()))
          .join('|');
        re += '(?:' + inner + ')';
        i = j;
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp('^' + re + '$');
}

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

// ---- frontmatter parsing -------------------------------------------------

function parseLore(content) {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const fmText = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\s+/, '').trim();

  const meta = {};
  let currentKey = null;
  for (const line of fmText.split('\n')) {
    const kv = line.match(/^([a-zA-Z_][\w-]*):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      let val = kv[2].trim();
      if (val === '') {
        meta[currentKey] = []; // block list follows on subsequent lines
      } else if (val.startsWith('[')) {
        meta[currentKey] = val
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((s) => s.trim().replace(/['"]/g, ''))
          .filter(Boolean);
      } else {
        meta[currentKey] = val.replace(/^['"]|['"]$/g, '');
      }
    } else {
      const item = line.match(/^\s*-\s*(.+)$/);
      if (item && currentKey && Array.isArray(meta[currentKey])) {
        meta[currentKey].push(item[1].trim().replace(/['"]/g, ''));
      }
    }
  }
  return { meta, body };
}

function loadLoreFiles(root) {
  const dir = path.join(root, '.lore');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    if (name.toLowerCase() === 'readme.md') continue;
    let content;
    try {
      content = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (_) {
      continue;
    }
    const parsed = parseLore(content);
    if (!parsed) continue;
    const paths = Array.isArray(parsed.meta.paths) ? parsed.meta.paths : [];
    if (!paths.length) continue;
    const globs = paths.map(normalizePath);
    entries.push({
      file: name,
      meta: parsed.meta,
      body: parsed.body,
      globs,
      matchers: globs.map((g) => {
        try {
          return globToRegExp(g);
        } catch (_) {
          return null;
        }
      }).filter(Boolean),
      // filename date prefix drives recency sort; fall back to empty string
      date: (name.match(/^(\d{4}-\d{2}-\d{2})/) || [, ''])[1],
    });
  }
  return entries;
}

function loreMatchesAny(entry, files) {
  return files.some((f) => entry.matchers.some((re) => re.test(f)));
}

// Fuzzy signal: does the prompt text reference a lore's path? Uses the static
// prefix of each glob (portion before the first wildcard), e.g. `src/payments/**`
// -> `src/payments`. Cheap, and precise enough to be useful without git.
function loreMentionedInText(entry, text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const g of entry.globs) {
    const pre = g.replace(/[*?{].*$/, '').replace(/\/+$/, '');
    if (pre.length >= 4 && pre.includes('/') && lower.includes(pre.toLowerCase())) {
      return true;
    }
  }
  return false;
}

// ---- candidate files -----------------------------------------------------

// Uncommitted / staged changes (-uall so new untracked dirs list their files
// individually instead of collapsing to the top-level directory).
function gitWorkingSet(root) {
  const files = new Set();
  for (const line of git('status --porcelain --untracked-files=all', root).split('\n')) {
    const s = line.slice(3).trim();
    if (!s) continue;
    const arrow = s.indexOf(' -> ');
    files.add(normalizePath(arrow >= 0 ? s.slice(arrow + 4) : s));
  }
  return [...files].filter(Boolean);
}

// Files touched across recent commits (robust for shallow / few-commit repos).
// This is what surfaces a teammate's just-merged lesson at session start.
function gitLogFiles(root) {
  const files = new Set();
  for (const line of git('log -n 20 --name-only --pretty=format:', root).split('\n')) {
    const s = line.trim();
    if (s) files.add(normalizePath(s));
  }
  return [...files].filter(Boolean);
}

// ---- rendering -----------------------------------------------------------

function firstLesson(body) {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine;
}

function render(entries, header) {
  const lines = [header];
  let used = header.length;
  let shown = 0;
  for (const e of entries) {
    if (shown >= MAX_ENTRIES) break;
    const kind = e.meta.kind || 'note';
    const by = e.meta.by || 'unknown';
    const date = e.date || '';
    const tag = `[${kind}, ${by}${date ? ', ' + date : ''}]`;
    let lesson = firstLesson(e.body);
    let line = `${shown + 1}. ${tag} ${lesson} (.lore/${e.file})`;
    if (used + line.length > MAX_CHARS) {
      // try a truncated lesson to still fit at least the pointer
      const budget = MAX_CHARS - used - (`${shown + 1}. ${tag}  (.lore/${e.file})`).length - 1;
      if (budget < 24) break;
      lesson = lesson.slice(0, budget).trimEnd() + '…';
      line = `${shown + 1}. ${tag} ${lesson} (.lore/${e.file})`;
    }
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown === 0) return null;
  lines.push('(Advisory context. Cite the .lore file if you act on it.)');
  return lines.join('\n');
}

function emit(hookEventName, text) {
  if (!text) return; // silent empty state
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } })
  );
}

// ---- per-session dedup (pretooluse mode) ---------------------------------

function dedupStatePath(sessionId) {
  const safe = String(sessionId || 'nosession').replace(/[^\w.-]/g, '_');
  return path.join(os.tmpdir(), `teamlore-${safe}-injected.txt`);
}

function readInjected(stateFile) {
  try {
    return new Set(fs.readFileSync(stateFile, 'utf8').split('\n').filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

function recordInjected(stateFile, files) {
  try {
    fs.appendFileSync(stateFile, files.map((f) => f + '\n').join(''));
  } catch (_) {
    /* best effort */
  }
}

// ---- main ----------------------------------------------------------------

function main() {
  const mode = process.argv[2] || 'session';
  const input = parseInput();
  const cwd = input.cwd || process.cwd();
  const root = repoRoot(cwd);
  const lore = loadLoreFiles(root);
  if (!lore.length) return;

  if (mode === 'prompt') {
    // UserPromptSubmit: re-evaluate the working set as it evolves, plus any
    // path referenced in the prompt. Dedup against everything injected earlier
    // this session (including the SessionStart digest) so recall stays quiet.
    const files = gitWorkingSet(root);
    const promptText = String(input.prompt || '');
    let matched = lore.filter(
      (e) => loreMatchesAny(e, files) || loreMentionedInText(e, promptText)
    );
    if (!matched.length) return;

    const stateFile = dedupStatePath(input.session_id);
    const injected = readInjected(stateFile);
    matched = matched.filter((e) => !injected.has(e.file));
    if (!matched.length) return;

    matched.sort((a, b) => (a.date < b.date ? 1 : -1));
    const shown = matched.slice(0, MAX_ENTRIES);
    const text = render(shown, `TEAMLORE RECALL (${shown.length} for what you're working on):`);
    if (text) {
      recordInjected(stateFile, shown.map((e) => e.file));
      emit('UserPromptSubmit', text);
    }
    return;
  }

  // session mode (SessionStart): broad digest from working set + recent commits.
  const files = gitWorkingSet(root).concat(gitLogFiles(root));
  if (!files.length) return;
  let matched = lore.filter((e) => loreMatchesAny(e, files));
  if (!matched.length) return;
  matched.sort((a, b) => (a.date < b.date ? 1 : -1));
  const scope = matched.length > MAX_ENTRIES ? matched.slice(0, MAX_ENTRIES) : matched;
  const text = render(scope, `TEAMLORE RECALL (${scope.length} for your recent work):`);
  if (text) {
    // record so the first UserPromptSubmit doesn't repeat the same entries
    recordInjected(dedupStatePath(input.session_id), scope.map((e) => e.file));
    emit('SessionStart', text);
  }
}

try {
  main();
} catch (_) {
  // never disrupt the session on recall failure
  process.exit(0);
}
