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
 *   root → one region per top-level path segment → lore leaves.
 *
 * Regions and their entries preserve first-seen order so the layout is stable.
 *
 * @param {object[]} lore  entries with `.id` and `.region`
 * @returns {{ id, type, children }}
 */
function buildLoreTree(lore) {
  const regions = {};
  const order = [];
  for (const L of lore) {
    const region = L.region || '(unscoped)';
    if (!regions[region]) {
      regions[region] = [];
      order.push(region);
    }
    regions[region].push({ id: L.id, type: 'lore' });
  }

  return {
    id: '__root__',
    type: 'root',
    children: order.map((r) => ({
      id: 'region:' + r,
      type: 'region',
      label: r,
      children: regions[r],
    })),
  };
}

module.exports = { globPrefix, pathsOverlap, buildLoreTree };
