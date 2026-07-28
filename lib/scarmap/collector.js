'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { globPrefix, buildLoreTree, pathsOverlap } = require('./edges');

// ── git / path helpers ───────────────────────────────────────────────────────

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

function repoName(root) {
  return path.basename(root) || 'repo';
}

function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

// ── frontmatter parsing ──────────────────────────────────────────────────────

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
        meta[currentKey] = [];
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

// ── decay / weight ───────────────────────────────────────────────────────────

const KIND_WEIGHT = { mistake: 3, gotcha: 2, decision: 1 };
const DECAY_FACTOR = { fresh: 1.0, aging: 0.7, stale: 0.4 };

/**
 * Compute decay state from verify_by date (if present) or lore filename date.
 *   verify_by present → stale if past, aging if ≤30 days away, fresh otherwise
 *   no verify_by      → use filename date: stale >180d, aging >90d, fresh otherwise
 */
function computeDecay(fileDate, verifyBy) {
  const now = new Date();

  if (verifyBy) {
    const vd = new Date(verifyBy);
    if (!isNaN(vd.getTime())) {
      const days = (vd - now) / 864e5;
      if (days < 0) return 'stale';
      if (days <= 30) return 'aging';
      return 'fresh';
    }
  }

  if (fileDate) {
    const fd = new Date(fileDate);
    if (!isNaN(fd.getTime())) {
      const age = (now - fd) / 864e5;
      if (age > 180) return 'stale';
      if (age > 90) return 'aging';
      return 'fresh';
    }
  }

  return 'aging'; // unknown date → middle ground
}

// ── lore loading ─────────────────────────────────────────────────────────────

function loadLoreEntries(root) {
  const dir = path.join(root, '.lore');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }

  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.md') || name.toLowerCase() === 'readme.md') continue;

    let content;
    try {
      content = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (_) {
      continue;
    }

    const parsed = parseLore(content);
    if (!parsed) continue;

    const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})/);
    const fileDate = dateMatch ? dateMatch[1] : (parsed.meta.date || '');
    const kind = parsed.meta.kind || 'decision';
    const decay = computeDecay(fileDate, parsed.meta.verify_by);
    const rawPaths = Array.isArray(parsed.meta.paths) ? parsed.meta.paths : [];
    const paths = rawPaths.map(normalizePath);
    const dirs = paths.map(globPrefix).filter(Boolean);
    const region = dirs.length ? dirs[0].split('/')[0] : '(unscoped)';

    entries.push({
      id: name,
      kind,
      kindWeight: KIND_WEIGHT[kind] || 1,
      decay,
      decayFactor: DECAY_FACTOR[decay] || 0.7,
      date: fileDate,
      by: parsed.meta.by || 'unknown',
      commit: parsed.meta.commit || '',
      paths,
      dirs,
      region,
      body: parsed.body,
      title: name
        .replace(/^\d{4}-\d{2}-\d{2}-/, '')
        .replace(/\.md$/, '')
        .replace(/-/g, ' '),
      verifyBy: parsed.meta.verify_by || '',
    });
  }

  return entries;
}

// ── repo directory tree ──────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '.lore']);
const MAX_DEPTH = 12;
const MAX_DIRS = 5000;
const MAX_FILES_PER_DIR = 200;
const MAX_FILES_TOTAL = 20000;

/**
 * Record a file under its parent dir, honoring the per-dir and global caps.
 * Overflow is counted per dir so the UI can render "… N more files".
 */
function addFile(bucket, dir, name) {
  const list = bucket.filesByDir[dir] || (bucket.filesByDir[dir] = []);
  if (bucket.total >= MAX_FILES_TOTAL || list.length >= MAX_FILES_PER_DIR) {
    bucket.droppedByDir[dir] = (bucket.droppedByDir[dir] || 0) + 1;
    return;
  }
  list.push(name);
  bucket.total++;
}

/** Filesystem-walk fallback: every directory and file path (relative to root). */
function walkRepo(root) {
  const dirs = [];
  const bucket = { filesByDir: {}, droppedByDir: {}, total: 0 };
  const state = { count: 0 };

  function walk(abs, rel, depth) {
    if (depth > MAX_DEPTH || state.count > MAX_DIRS) return;
    let ents;
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of ents) {
      // isDirectory()/isFile() are false for symlinks → symlink loops are avoided.
      if (ent.isFile()) {
        addFile(bucket, rel, ent.name);
        continue;
      }
      if (!ent.isDirectory()) continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      dirs.push(childRel);
      state.count++;
      walk(path.join(abs, ent.name), childRel, depth + 1);
    }
  }

  walk(root, '', 0);
  return { dirSet: new Set(dirs), filesByDir: bucket.filesByDir, droppedByDir: bucket.droppedByDir };
}

/** Derive dirs + per-dir file lists from a flat list of file paths. */
function entriesFromFiles(files) {
  const dirSet = new Set();
  const bucket = { filesByDir: {}, droppedByDir: {}, total: 0 };
  for (const f of files) {
    const parts = normalizePath(f).split('/');
    const base = parts.pop();
    let acc = '';
    for (const p of parts) {
      acc = acc ? acc + '/' + p : p;
      dirSet.add(acc);
    }
    if (base) addFile(bucket, acc, base);
  }
  return { dirSet, filesByDir: bucket.filesByDir, droppedByDir: bucket.droppedByDir };
}

/**
 * Collect the repo's directories and files. Prefer tracked files (git
 * ls-files); fall back to an fs-walk when git returns nothing (non-git dir,
 * or a gitignored fixture whose files aren't tracked).
 *
 * @returns {{ dirSet: Set, filesByDir: Object, droppedByDir: Object }}
 *          filesByDir/droppedByDir are keyed by dir path ('' = repo root).
 */
function collectRepoEntries(root) {
  const out = git('ls-files', root).trim();
  if (out) return entriesFromFiles(out.split('\n').filter(Boolean));
  return walkRepo(root);
}

/**
 * Build a nested tree from a flat set of directory paths plus per-dir file
 * lists. Dir nodes: { name, path, isDir:true, children, phantom? }. File
 * leaves: { name, isDir:false } — no path field; nothing downstream consumes
 * file paths and omitting them keeps the inlined JSON payload small.
 * Children are sorted dirs-first, then case-insensitive alphabetical.
 */
function buildNestedTree(dirPaths, phantomSet, filesByDir, droppedByDir) {
  const root = { name: '', path: '', isDir: true, children: [] };
  const map = { '': root };
  const sorted = Array.from(dirPaths).sort();
  for (const p of sorted) {
    const parts = p.split('/');
    let acc = '';
    let parent = root;
    for (const part of parts) {
      acc = acc ? acc + '/' + part : part;
      let node = map[acc];
      if (!node) {
        node = { name: part, path: acc, isDir: true, children: [] };
        if (phantomSet.has(acc)) node.phantom = true;
        map[acc] = node;
        parent.children.push(node);
      }
      parent = node;
    }
  }

  if (filesByDir) {
    for (const dir in filesByDir) {
      const node = map[dir];
      if (!node) continue;
      for (const name of filesByDir[dir]) {
        node.children.push({ name, isDir: false });
      }
    }
  }
  if (droppedByDir) {
    for (const dir in droppedByDir) {
      if (map[dir]) map[dir].droppedFiles = droppedByDir[dir];
    }
  }

  sortTree(root);
  return root;
}

/** Recursively sort children: dirs first, then files, each alphabetical. */
function sortTree(node) {
  node.children.sort((a, b) => {
    const ad = a.isDir !== false ? 0 : 1;
    const bd = b.isDir !== false ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
  for (const c of node.children) {
    if (c.isDir !== false) sortTree(c);
  }
}

// ── heat ─────────────────────────────────────────────────────────────────────

const GLOW = 0.5;

/**
 * Per-directory heat, log-normalized to [0,1].
 *
 * A directory's *own* heat is Σ (kindWeight × decayFactor) over the lore whose
 * glob resolves exactly to it — so density and severity of the hotspot itself
 * drive the color. Ancestors receive a *glow*: the max of their descendants'
 * own-heat decayed by 0.5^depth. Because glow is a decayed **max** (never a
 * sum), an ancestor is always cooler than its hottest child — the specific
 * scarred dir blazes reddest, and the path up to it stays merely warm.
 *
 * @returns {{ heat: Object, loreByDir: Object }}
 */
function computeHeat(lore) {
  const own = {};
  const loreByDir = {};

  for (const L of lore) {
    const c = L.kindWeight * L.decayFactor;
    for (const d of L.dirs) {
      if (!d) continue;
      own[d] = (own[d] || 0) + c;
      (loreByDir[d] = loreByDir[d] || []).push(L.id);
    }
  }

  // Glow: propagate each dir's own heat up to ancestors as a decaying max.
  const glow = {};
  for (const d in own) {
    let cur = d;
    let k = 0;
    while (cur) {
      if (k > 0) glow[cur] = Math.max(glow[cur] || 0, own[d] * Math.pow(GLOW, k));
      const idx = cur.lastIndexOf('/');
      if (idx < 0) break;
      cur = cur.slice(0, idx);
      k++;
    }
  }

  const raw = {};
  for (const k in own) raw[k] = Math.max(own[k], glow[k] || 0);
  for (const k in glow) if (!(k in raw)) raw[k] = glow[k];

  let maxRaw = 0;
  for (const key in raw) if (raw[key] > maxRaw) maxRaw = raw[key];

  const heat = {};
  const denom = maxRaw > 0 ? Math.log1p(maxRaw) : 1;
  for (const key in raw) {
    heat[key] = {
      raw: raw[key],
      norm: maxRaw > 0 ? Math.log1p(raw[key]) / denom : 0,
    };
  }
  return { heat, loreByDir };
}

/** Directories referenced by lore but absent from the collected tree. */
function phantomDirs(lore, dirSet) {
  const phantom = new Set();
  for (const L of lore) {
    for (const d of L.dirs) {
      let cur = d;
      while (cur) {
        if (!dirSet.has(cur)) phantom.add(cur);
        const idx = cur.lastIndexOf('/');
        if (idx < 0) break;
        cur = cur.slice(0, idx);
      }
    }
  }
  return phantom;
}

// ── collection ───────────────────────────────────────────────────────────────

/**
 * Collect the full scarmap payload from a repo.
 *
 * @param {string} [targetDir]  — repo root (or explicit root, see opts)
 * @param {{ explicitRoot?: boolean }} [opts]
 *        explicitRoot=true → treat targetDir as the root verbatim (skip
 *        `git rev-parse`, which would climb to an enclosing repo).
 * @returns {{ repoName, root, lore, tree, heat, loreByDir, loreTree }}
 */
function collect(targetDir, opts) {
  const base = targetDir || process.cwd();
  const root = opts && opts.explicitRoot ? path.resolve(base) : repoRoot(base);
  const name = repoName(root);

  const lore = loadLoreEntries(root);

  const { dirSet, filesByDir, droppedByDir } = collectRepoEntries(root);
  const phantom = phantomDirs(lore, dirSet);
  for (const p of phantom) dirSet.add(p);

  const tree = buildNestedTree(dirSet, phantom, filesByDir, droppedByDir);
  const { heat, loreByDir } = computeHeat(lore);
  const loreTree = buildLoreTree(lore);
  const loreTrees = {
    area: loreTree,
    // Author key is normalized (trim + lowercase) so `Priya`/`priya` merge
    // into one hub; the label keeps the first-seen display casing.
    author: buildLoreTree(
      lore,
      (L) => {
        const raw = String(L.by || '').trim();
        return { key: raw.toLowerCase() || 'unknown', label: raw || 'unknown' };
      },
      'author:'
    ),
  };
  const loreLinks = computeLoreLinks(lore);

  return { repoName: name, root, lore, tree, heat, loreByDir, loreTree, loreTrees, loreLinks };
}

/**
 * Cross-links between lore entries whose paths overlap — these give the
 * knowledge graph its clusters (related incidents attract each other).
 * @returns {Array<[string, string]>} pairs of lore ids
 */
function computeLoreLinks(lore) {
  const links = [];
  for (let i = 0; i < lore.length; i++) {
    for (let j = i + 1; j < lore.length; j++) {
      if (pathsOverlap(lore[i].paths, lore[j].paths)) {
        links.push([lore[i].id, lore[j].id]);
      }
    }
  }
  return links;
}

module.exports = {
  collect,
  repoRoot,
  repoName,
  collectRepoEntries,
  computeHeat,
  buildNestedTree,
};
