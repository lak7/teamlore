'use strict';

// ── path helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the static directory portion of a glob.
 *   'src/payments/**' → 'src/payments'
 *   'lib/auth/*.ts'   → 'lib/auth'
 *   '**'              → ''
 */
function globPrefix(glob) {
  const clean = String(glob).replace(/[*?{].*$/, '').replace(/\/+$/, '');
  return clean || '';
}

/**
 * Check if two sets of path globs have meaningful overlap.
 * Overlap = one glob prefix is a prefix of the other, or they share the same
 * parent directory.
 */
function pathsOverlap(pathsA, pathsB) {
  for (const a of pathsA) {
    const pa = globPrefix(a);
    if (pa.length < 2) continue;
    for (const b of pathsB) {
      const pb = globPrefix(b);
      if (pb.length < 2) continue;
      if (pa === pb || pa.startsWith(pb + '/') || pb.startsWith(pa + '/')) return true;
      const dirA = pa.lastIndexOf('/') > 0 ? pa.slice(0, pa.lastIndexOf('/')) : '';
      const dirB = pb.lastIndexOf('/') > 0 ? pb.slice(0, pb.lastIndexOf('/')) : '';
      if (dirA && dirA === dirB) return true;
    }
  }
  return false;
}

// ── lore hierarchy ───────────────────────────────────────────────────────────

/**
 * Build the synthetic hierarchy for the vertical lore tree:
 *   root → one hub per bucket key → lore leaves.
 *
 * Defaults to bucketing by region (top-level path segment). Pass a keyFn to
 * bucket differently (e.g. by author). keyFn may return either a string key
 * or { key, label } when the grouping key differs from the display label
 * (e.g. lowercased author key, first-seen display casing).
 *
 * Hubs and their entries preserve first-seen order so the layout is stable.
 *
 * @param {object[]} lore  entries with `.id` and `.region`
 * @param {(L: object) => string|{key: string, label: string}} [keyFn]
 * @param {string} [idPrefix]  hub id prefix (default 'region:')
 * @returns {{ id, type, children }}
 */
function buildLoreTree(lore, keyFn, idPrefix) {
  keyFn = keyFn || ((L) => L.region || '(unscoped)');
  idPrefix = idPrefix || 'region:';
  const buckets = {};
  const labels = {};
  const order = [];
  for (const L of lore) {
    const k = keyFn(L);
    const key = typeof k === 'object' ? k.key : k;
    const label = typeof k === 'object' ? k.label : k;
    if (!buckets[key]) {
      buckets[key] = [];
      labels[key] = label;
      order.push(key);
    }
    buckets[key].push({ id: L.id, type: 'lore' });
  }

  return {
    id: '__root__',
    type: 'root',
    children: order.map((k) => ({
      id: idPrefix + k,
      type: 'region',
      label: labels[k],
      children: buckets[k],
    })),
  };
}

module.exports = { globPrefix, pathsOverlap, buildLoreTree };
