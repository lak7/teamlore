/* ═══════════════════════════════════════════════════════════════════════════
   scarmap — vertical lore tree + project-structure explorer (browser runtime)
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var data = typeof GRAPH_DATA !== 'undefined' ? GRAPH_DATA : {};
  var lore = data.lore || [];
  var tree = data.tree || { children: [] };
  var heat = data.heat || {};
  var loreByDir = data.loreByDir || {};
  var loreTree = data.loreTree || { children: [] };
  var loreLinks = data.loreLinks || [];

  // ── elements ───────────────────────────────────────────────────────────────
  var wfView = document.getElementById('workflow-view');
  var edgeCanvas = document.getElementById('edge-canvas');
  var nodeCards = document.getElementById('node-cards');
  var gridBg = document.getElementById('grid-bg');

  var dirTreeBody = document.getElementById('dir-tree-body');
  var dirTreeAside = document.getElementById('dir-tree');

  var popover = document.getElementById('lore-popover');
  var popoverContent = document.getElementById('popover-content');
  var btnClosePopover = document.getElementById('btn-close-popover');

  var btnZoomIn = document.getElementById('btn-zoom-in');
  var btnZoomOut = document.getElementById('btn-zoom-out');
  var btnZoomFit = document.getElementById('btn-zoom-fit');
  var btnTheme = document.getElementById('btn-theme');
  var btnCamera = document.getElementById('btn-camera');
  var btnHighlight = document.getElementById('btn-highlight');

  // ── sparse guard ─────────────────────────────────────────────────────────
  var SPARSE_THRESHOLD = 5;
  if (lore.length < SPARSE_THRESHOLD) {
    document.getElementById('sparse-view').classList.remove('hidden');
    renderSparseView();
    if (wfView) wfView.classList.add('hidden');
    if (dirTreeAside) dirTreeAside.classList.add('hidden');
    return;
  }
  if (!wfView) return;

  // ── force simulation constants ───────────────────────────────────────────
  var REPULSION = 620;       // repulsion per unit of combined effective radius
  var GRAVITY = 0.012;       // pull toward origin
  var DAMPING = 0.82;        // velocity decay per tick
  var ALPHA_DECAY = 0.99;    // sim cooling
  var ALPHA_MIN = 0.02;      // sim considered settled below this
  var SPRING_HIER = 0.04;    // root→region, region→lore springs
  var SPRING_CROSS = 0.008;  // lore↔lore similarity springs (softer)
  var REST_ROOT = 260;       // root→region rest length
  var REST_REGION = 360;     // region→lore rest length (card-scaled)
  var REST_CROSS = 430;      // lore↔lore rest length (card-scaled)
  var COLLIDE_PAD = 16;      // minimum gap enforced between node rectangles

  // ── state ────────────────────────────────────────────────────────────────
  var ctx = edgeCanvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var width = 0, height = 0;

  var transform = { x: 0, y: 0, k: 1 };
  var isPanning = false;
  var lastMouse = { x: 0, y: 0 };

  var selectedId = null;
  var highlightActive = false;
  var highlightLoreIds = {};

  // Hover cross-highlight is on by default; users can mute it (persisted).
  var highlightEnabled = true;
  try { highlightEnabled = localStorage.getItem('scarmap:highlight') !== 'off'; } catch (e) { /* file:// storage may be blocked */ }

  // Grouping mode: hubs are code areas or authors (persisted).
  var groupMode = 'area';
  try { if (localStorage.getItem('scarmap:group') === 'author') groupMode = 'author'; } catch (e) { /* ignore */ }
  function activeTree() {
    return (data.loreTrees && data.loreTrees[groupMode]) || loreTree;
  }

  var theme = document.documentElement.getAttribute('data-theme') || 'dark';

  var EDGE_COLORS = { dark: 'rgba(148,163,184,0.30)', light: 'rgba(100,116,139,0.30)' };
  var EDGE_HI     = { dark: 'rgba(96,165,250,0.85)',  light: 'rgba(37,99,235,0.85)' };

  var loreById = {};
  for (var i = 0; i < lore.length; i++) loreById[lore[i].id] = lore[i];

  // Built during graph setup:
  var rootNode = null;
  var regionNodes = [];
  var simNodes = [];        // all force-sim nodes (root + regions + lore)
  var edges = [];           // { a, b, rest, k, cross }
  var loreAdj = {};         // loreId -> { neighborLoreId: true } (cross-links)
  var alpha = 1;            // sim temperature
  var didAutoFit = false;
  var dragNode = null;
  var dragMoved = false;

  var cardEls = {};        // loreId  -> DOM graph node
  var regionEls = {};      // regionId -> DOM graph node
  var rootEl = null;
  var dirNodeEls = {};      // dirPath -> { wrap, row, childrenEl }

  // ── inline icons (lucide, ISC license) ──────────────────────────────────────
  var SVG_PRE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICONS = {
    chevron: SVG_PRE + '<path d="m9 18 6-6-6-6"/></svg>',
    folder: SVG_PRE + '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
    folderOpen: SVG_PRE + '<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/></svg>',
    file: SVG_PRE + '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>'
  };

  // extension -> [glyph text, color class]; anything else gets the file icon
  var FILE_GLYPHS = {
    ts: ['TS', 'ft-ts'], tsx: ['TS', 'ft-ts'],
    js: ['JS', 'ft-js'], jsx: ['JS', 'ft-js'], mjs: ['JS', 'ft-js'], cjs: ['JS', 'ft-js'],
    json: ['{}', 'ft-json'],
    md: ['M↓', 'ft-md'],
    css: ['#', 'ft-css'], scss: ['#', 'ft-css'], less: ['#', 'ft-css'],
    html: ['<>', 'ft-html'], htm: ['<>', 'ft-html'],
    yml: ['Y', 'ft-yaml'], yaml: ['Y', 'ft-yaml']
  };

  function fileGlyph(name) {
    var dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    return FILE_GLYPHS[name.slice(dot + 1).toLowerCase()] || null;
  }

  // ── graph: force-directed knowledge graph over loreTree + cross-links ───────
  function setupGraph() {
    rootNode = {
      id: '__root__', type: 'root', label: data.repoName || 'repo',
      x: 0, y: 0, vx: 0, vy: 0, r: 16, w: 32, h: 32, er: 16, pinned: true
    };
    regionNodes = [];
    simNodes = [rootNode];
    edges = [];
    loreAdj = {};

    var loreNodeById = {};
    var regionChildren = activeTree().children || [];
    for (var r = 0; r < regionChildren.length; r++) {
      var reg = regionChildren[r];
      var kids = reg.children || [];
      var ang = (r / Math.max(1, regionChildren.length)) * Math.PI * 2 - Math.PI / 2;
      var regionR = 9 + Math.min(6, kids.length);
      var region = {
        id: reg.id, type: 'region', label: reg.label,
        x: Math.cos(ang) * REST_ROOT, y: Math.sin(ang) * REST_ROOT,
        vx: 0, vy: 0, r: regionR, w: regionR * 2, h: regionR * 2, er: regionR,
        leafIds: [], kindCounts: { mistake: 0, gotcha: 0, decision: 0 }
      };
      regionNodes.push(region);
      simNodes.push(region);
      edges.push({ a: rootNode, b: region, rest: REST_ROOT, k: SPRING_HIER, cross: false });

      for (var c = 0; c < kids.length; c++) {
        var loreObj = loreById[kids[c].id];
        if (!loreObj) continue;
        // Fan lore out around its region's angle so the sim starts untangled.
        var a2 = ang + (c - (kids.length - 1) / 2) * 0.55;
        var rad = REST_ROOT + REST_REGION;
        var leaf = {
          id: loreObj.id, type: 'lore', lore: loreObj, kind: loreObj.kind,
          x: Math.cos(a2) * rad, y: Math.sin(a2) * rad,
          vx: 0, vy: 0,
          // card dimensions are estimates until measureNodes() reads the DOM
          r: 8, w: 260, h: 150, er: 150
        };
        region.leafIds.push(loreObj.id);
        var kk = KIND_ORDER.indexOf(loreObj.kind) >= 0 ? loreObj.kind : 'decision';
        region.kindCounts[kk]++;
        loreNodeById[loreObj.id] = leaf;
        simNodes.push(leaf);
        edges.push({ a: region, b: leaf, rest: REST_REGION, k: SPRING_HIER, cross: false });
      }
    }

    // Similarity cross-links: related incidents attract and cluster.
    for (var l = 0; l < loreLinks.length; l++) {
      var na = loreNodeById[loreLinks[l][0]];
      var nb = loreNodeById[loreLinks[l][1]];
      if (!na || !nb) continue;
      edges.push({ a: na, b: nb, rest: REST_CROSS, k: SPRING_CROSS, cross: true });
      (loreAdj[na.id] = loreAdj[na.id] || {})[nb.id] = true;
      (loreAdj[nb.id] = loreAdj[nb.id] || {})[na.id] = true;
    }

    alpha = 1;
    didAutoFit = false;
  }

  function simTick() {
    if (alpha < ALPHA_MIN) return;
    var i, j, n, m, dx, dy, d2, d, f;
    var count = simNodes.length;

    // Pairwise repulsion, scaled by combined node footprint (cards push
    // harder than dots). O(n²) — fine below a few hundred nodes.
    for (i = 0; i < count; i++) {
      n = simNodes[i];
      for (j = i + 1; j < count; j++) {
        m = simNodes[j];
        dx = m.x - n.x;
        dy = m.y - n.y;
        d2 = dx * dx + dy * dy;
        if (d2 > 1690000) continue;        // beyond 1300px: negligible
        if (d2 < 64) { d2 = 64; dx = dx || 1; }
        f = (REPULSION * (n.er + m.er) / d2) * alpha;
        d = Math.sqrt(d2);
        var ux = dx / d, uy = dy / d;
        n.vx -= ux * f; n.vy -= uy * f;
        m.vx += ux * f; m.vy += uy * f;
      }
    }

    // Edge springs.
    for (i = 0; i < edges.length; i++) {
      var e = edges[i];
      dx = e.b.x - e.a.x;
      dy = e.b.y - e.a.y;
      d = Math.sqrt(dx * dx + dy * dy) || 1;
      f = (d - e.rest) * e.k * alpha;
      var sx = (dx / d) * f, sy = (dy / d) * f;
      e.a.vx += sx; e.a.vy += sy;
      e.b.vx -= sx; e.b.vy -= sy;
    }

    // Gravity + integration.
    for (i = 0; i < count; i++) {
      n = simNodes[i];
      if (n.pinned || n === dragNode) { n.vx = 0; n.vy = 0; continue; }
      n.vx = (n.vx - n.x * GRAVITY * alpha) * DAMPING;
      n.vy = (n.vy - n.y * GRAVITY * alpha) * DAMPING;
      n.x += n.vx;
      n.y += n.vy;
    }

    // Rectangle collision: hard guarantee that cards never overlap —
    // repulsion alone can't promise that. Push overlapping pairs apart
    // along the axis of least penetration (rect flavor of d3-force-collide).
    for (i = 0; i < count; i++) {
      n = simNodes[i];
      for (j = i + 1; j < count; j++) {
        m = simNodes[j];
        dx = m.x - n.x;
        dy = m.y - n.y;
        var ox = (n.w + m.w) / 2 + COLLIDE_PAD - Math.abs(dx);
        var oy = (n.h + m.h) / 2 + COLLIDE_PAD - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        var nMovable = !(n.pinned || n === dragNode);
        var mMovable = !(m.pinned || m === dragNode);
        if (!nMovable && !mMovable) continue;
        if (ox < oy) {
          var sx = ox * (dx < 0 ? -1 : 1);
          if (nMovable && mMovable) { n.x -= sx / 2; m.x += sx / 2; }
          else if (nMovable) n.x -= sx;
          else m.x += sx;
        } else {
          var sy = oy * (dy < 0 ? -1 : 1);
          if (nMovable && mMovable) { n.y -= sy / 2; m.y += sy / 2; }
          else if (nMovable) n.y -= sy;
          else m.y += sy;
        }
      }
    }

    alpha *= ALPHA_DECAY;

    // Once the layout has mostly settled, frame it.
    if (!didAutoFit && alpha < 0.12) {
      didAutoFit = true;
      zoomFit();
    }
  }

  // ── DOM nodes (Obsidian-style dots + labels) ───────────────────────────────
  function createGraphNodes() {
    nodeCards.innerHTML = '';
    cardEls = {};
    regionEls = {};
    rootEl = null;

    for (var i = 0; i < simNodes.length; i++) {
      (function (n) {
        var el = document.createElement('div');
        el.className = 'g-node ' + n.type + (n.type === 'lore' ? ' ' + n.kind : '');

        if (n.type === 'lore') {
          var L = n.lore;
          var snippet = L.body.length > 110 ? L.body.substring(0, 107) + '…' : L.body;
          var card = document.createElement('div');
          card.className = 'g-card';
          card.innerHTML =
            '<div class="g-card-header">' +
              '<span class="g-kind-dot ' + L.kind + '"></span>' +
              '<span class="g-card-title">' + esc(L.title) + '</span>' +
            '</div>' +
            '<div class="g-card-body">' +
              '<div class="g-badges">' +
                '<span class="g-badge ' + L.kind + '">' + esc(L.kind) + '</span>' +
                '<span class="g-badge decay">' + esc(L.decay) + '</span>' +
              '</div>' +
              '<div class="g-card-text">' + esc(snippet) + '</div>' +
              '<div class="g-card-meta">' +
                '<span>👤 ' + esc(L.by) + '</span>' +
                '<span>📁 ' + esc(L.paths[0] || '') + (L.paths.length > 1 ? ' +' + (L.paths.length - 1) : '') + '</span>' +
              '</div>' +
            '</div>';
          el.appendChild(card);
        } else {
          var dot = document.createElement('div');
          dot.className = 'g-dot';
          dot.style.width = (n.r * 2) + 'px';
          dot.style.height = (n.r * 2) + 'px';

          var label = document.createElement('div');
          label.className = 'g-label';
          label.style.top = (n.r + 5) + 'px';
          if (n.type === 'region') {
            if (groupMode === 'author' && n.kindCounts) {
              // Author hubs show a per-kind breakdown (dot + count pairs,
              // same visual language as the dir tree's rollups).
              var pairs = '';
              for (var kx = 0; kx < KIND_ORDER.length; kx++) {
                var kd = KIND_ORDER[kx];
                if (!n.kindCounts[kd]) continue;
                pairs +=
                  '<span class="scar-pair">' +
                    '<span class="scar-dot ' + kd + '"></span>' +
                    '<span class="scar-n">' + n.kindCounts[kd] + '</span>' +
                  '</span>';
              }
              label.innerHTML = esc(n.label) + '<span class="g-kinds">' + pairs + '</span>';
            } else {
              label.innerHTML = esc(n.label) + ' <span class="g-count">' + n.leafIds.length + '</span>';
            }
          } else {
            label.textContent = n.label;
          }

          el.appendChild(dot);
          el.appendChild(label);
        }

        el.addEventListener('mousedown', function (e) {
          e.stopPropagation();
          if (!n.pinned) { dragNode = n; dragMoved = false; lastMouse = { x: e.clientX, y: e.clientY }; }
        });
        if (n.type === 'lore') {
          el.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!dragMoved) selectLore(n.id, e.clientX, e.clientY);
          });
          el.addEventListener('mouseenter', function () { hoverLore(n.lore); });
          el.addEventListener('mouseleave', clearHighlight);
        } else if (n.type === 'region') {
          el.addEventListener('mouseenter', function () { hoverRegion(n); });
          el.addEventListener('mouseleave', clearHighlight);
        }

        nodeCards.appendChild(el);
        n.el = el;
        if (n.type === 'lore') cardEls[n.id] = el;
        if (n.type === 'region') regionEls[n.id] = el;
        if (n.type === 'root') rootEl = el;
      })(simNodes[i]);
    }

    measureNodes();
  }

  /** Read real card dimensions from the DOM so the physics uses true sizes. */
  function measureNodes() {
    for (var i = 0; i < simNodes.length; i++) {
      var n = simNodes[i];
      var inner = n.el && n.el.firstChild;
      if (inner && inner.offsetWidth) {
        n.w = inner.offsetWidth;
        n.h = inner.offsetHeight;
      } else {
        n.w = n.r * 2;
        n.h = n.r * 2;
      }
      n.er = Math.sqrt(n.w * n.w + n.h * n.h) / 2;
    }
  }

  function updateNodePositions() {
    nodeCards.style.transform =
      'translate(' + transform.x + 'px,' + transform.y + 'px) scale(' + transform.k + ')';
    nodeCards.classList.toggle('labels-min', transform.k < 0.25);
    var bg = 24 * transform.k;
    gridBg.style.backgroundSize = bg + 'px ' + bg + 'px';
    gridBg.style.backgroundPosition = transform.x + 'px ' + transform.y + 'px';

    for (var i = 0; i < simNodes.length; i++) {
      var n = simNodes[i];
      if (n.el) n.el.style.transform = 'translate(' + n.x + 'px,' + n.y + 'px)';
    }
  }

  // ── edges (straight lines; dashed = similarity cross-links) ────────────────
  function nodeOn(n) {
    if (n.type === 'lore') return !!highlightLoreIds[n.id];
    if (n.type === 'region') {
      for (var i = 0; i < n.leafIds.length; i++) if (highlightLoreIds[n.leafIds[i]]) return true;
      return false;
    }
    if (n.type === 'root') { for (var k in highlightLoreIds) return true; return false; }
    return false;
  }

  function renderEdges() {
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    for (var i = 0; i < edges.length; i++) {
      var e = edges[i];
      var on = highlightActive ? (nodeOn(e.a) && nodeOn(e.b)) : null;
      ctx.beginPath();
      ctx.setLineDash(e.cross ? [5, 5] : []);
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.lineWidth = on ? 2.5 : (e.cross ? 1.2 : 1.6);
      ctx.strokeStyle = on ? EDGE_HI[theme] : EDGE_COLORS[theme];
      ctx.globalAlpha = (highlightActive && !on) ? 0.06 : (e.cross ? 0.75 : 1);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── directory tree, VS Code-style file explorer (right) ─────────────────────
  var KIND_ORDER = ['mistake', 'gotcha', 'decision'];
  var KIND_W = { mistake: 3, gotcha: 2, decision: 1 };
  var aggByPath = {};   // dirPath -> { mistake, gotcha, decision, total }

  /**
   * Post-order subtree rollup: own lore + all descendants', deduped by lore
   * id so an entry scoped to several dirs in the same subtree counts once.
   */
  function computeAggs(node) {
    var idSet = {};
    var ids = loreByDir[node.path] || [];
    for (var i = 0; i < ids.length; i++) idSet[ids[i]] = true;

    var kids = node.children || [];
    for (var c = 0; c < kids.length; c++) {
      if (kids[c].isDir === false) continue;
      var sub = computeAggs(kids[c]);
      for (var sid in sub) idSet[sid] = true;
    }

    var agg = { mistake: 0, gotcha: 0, decision: 0, total: 0 };
    for (var id in idSet) {
      var L = loreById[id];
      if (!L) continue;
      var kind = KIND_ORDER.indexOf(L.kind) >= 0 ? L.kind : 'decision';
      agg[kind]++;
      agg.total++;
    }
    aggByPath[node.path] = agg;
    return idSet;
  }

  function dominantKind(counts) {
    var dom = 'decision';
    var best = -1;
    for (var k = 0; k < KIND_ORDER.length; k++) {
      var kd = KIND_ORDER[k];
      var w = (counts[kd] || 0) * KIND_W[kd];
      if (w > best) { best = w; dom = kd; }
    }
    return dom;
  }

  function renderDirTree() {
    aggByPath = {};
    computeAggs(tree);
    dirTreeBody.innerHTML = '';
    var kids = tree.children || [];
    for (var i = 0; i < kids.length; i++) {
      dirTreeBody.appendChild(buildDirNode(kids[i], 0));
    }
    // Top-level dirs open by default (second level visible, like an editor).
    for (var j = 0; j < kids.length; j++) {
      if (kids[j].isDir !== false && dirNodeEls[kids[j].path]) {
        dirNodeEls[kids[j].path].wrap.classList.add('open');
      }
    }
    // Scarred paths are always revealed on load.
    for (var p in loreByDir) expandTo(p);
  }

  function buildDirNode(node, depth) {
    var isDir = node.isDir !== false;
    var wrap = document.createElement('div');
    wrap.className = 'dir-node';

    var row = document.createElement('div');
    row.className = 'dir-row ' + (isDir ? 'dir' : 'file') + (node.phantom ? ' phantom' : '');
    row.style.paddingLeft = (8 + depth * 16) + 'px';

    var expandable = isDir && ((node.children && node.children.length) || node.droppedFiles);

    var chevron = document.createElement('span');
    chevron.className = 'dir-chevron';
    if (expandable) chevron.innerHTML = ICONS.chevron;

    var icon = document.createElement('span');
    if (isDir) {
      icon.className = 'dir-icon';
      icon.innerHTML =
        '<span class="icon-closed">' + ICONS.folder + '</span>' +
        '<span class="icon-open">' + ICONS.folderOpen + '</span>';
    } else {
      var g = fileGlyph(node.name);
      if (g) {
        icon.className = 'dir-ficon ' + g[1];
        icon.textContent = g[0];
      } else {
        icon.className = 'dir-ficon ft-file';
        icon.innerHTML = ICONS.file;
      }
    }

    var name = document.createElement('span');
    name.className = 'dir-name';
    name.textContent = node.name;

    row.appendChild(chevron);
    row.appendChild(icon);
    row.appendChild(name);

    if (isDir) {
      applyScarSignal(row, node);
      applyAggSignal(row, node);
    }

    wrap.appendChild(row);

    var childrenEl = null;
    if (expandable) {
      childrenEl = document.createElement('div');
      childrenEl.className = 'dir-children';
      childrenEl.style.setProperty('--guide-x', (8 + depth * 16 + 7) + 'px');
      var kids = node.children || [];
      for (var i = 0; i < kids.length; i++) {
        childrenEl.appendChild(buildDirNode(kids[i], depth + 1));
      }
      if (node.droppedFiles) {
        var more = document.createElement('div');
        more.className = 'dir-row dir-more';
        more.style.paddingLeft = (8 + (depth + 1) * 16 + 20) + 'px';
        more.textContent = '… ' + node.droppedFiles + ' more files';
        childrenEl.appendChild(more);
      }
      wrap.appendChild(childrenEl);

      row.addEventListener('click', function (e) {
        e.stopPropagation();
        wrap.classList.toggle('open');
      });
    }

    if (isDir) {
      dirNodeEls[node.path] = { wrap: wrap, row: row, childrenEl: childrenEl };
      row.addEventListener('mouseenter', function () { hoverDir(node.path); });
      row.addEventListener('mouseleave', clearHighlight);
    }

    return wrap;
  }

  /**
   * Scar affordances for a dir with its own lore: a kind-colored left accent
   * (dominant kind), one tiny dot per distinct kind, and a count chip.
   * Ancestor dirs that only receive heat "glow" stay fully neutral.
   */
  function applyScarSignal(row, node) {
    var ids = loreByDir[node.path] || [];
    if (!ids.length) return;

    var counts = {};
    for (var i = 0; i < ids.length; i++) {
      var L = loreById[ids[i]];
      if (!L) continue;
      var kind = KIND_ORDER.indexOf(L.kind) >= 0 ? L.kind : 'decision';
      counts[kind] = (counts[kind] || 0) + 1;
    }
    row.classList.add('scarred', 'k-' + dominantKind(counts));

    var scar = document.createElement('span');
    scar.className = 'dir-scar own';
    for (var d = 0; d < KIND_ORDER.length; d++) {
      if (counts[KIND_ORDER[d]]) {
        var dot = document.createElement('span');
        dot.className = 'scar-dot ' + KIND_ORDER[d];
        scar.appendChild(dot);
      }
    }
    var chip = document.createElement('span');
    chip.className = 'dir-heat-count';
    chip.textContent = ids.length;
    scar.appendChild(chip);
    row.appendChild(scar);

    var h = heat[node.path];
    if (h && h.norm > 0.6) row.classList.add('hot');
  }

  /**
   * Collapsed-state rollup: per-kind subtree totals (dot + count pairs),
   * shown only while the dir is closed so open dirs never double-count
   * what's already visible on their children.
   */
  function applyAggSignal(row, node) {
    var agg = aggByPath[node.path];
    if (!agg || !agg.total) return;

    row.classList.add('agg-scarred', 'ka-' + dominantKind(agg));

    var scar = document.createElement('span');
    scar.className = 'dir-scar agg';
    for (var d = 0; d < KIND_ORDER.length; d++) {
      var kd = KIND_ORDER[d];
      if (!agg[kd]) continue;
      var pair = document.createElement('span');
      pair.className = 'scar-pair';
      var dot = document.createElement('span');
      dot.className = 'scar-dot ' + kd;
      var num = document.createElement('span');
      num.className = 'scar-n';
      num.textContent = agg[kd];
      pair.appendChild(dot);
      pair.appendChild(num);
      scar.appendChild(pair);
    }
    row.appendChild(scar);
  }

  function expandTo(path) {
    var parts = path.split('/');
    var acc = '';
    for (var i = 0; i < parts.length; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      var d = dirNodeEls[acc];
      if (d) d.wrap.classList.add('open');
    }
  }

  // ── cross-highlight ──────────────────────────────────────────────────────
  function loreForDir(path) {
    var out = {};
    for (var i = 0; i < lore.length; i++) {
      var ds = lore[i].dirs || [];
      for (var j = 0; j < ds.length; j++) {
        if (ds[j] === path || ds[j].indexOf(path + '/') === 0) { out[lore[i].id] = true; break; }
      }
    }
    return out;
  }

  function dirsForLore(loreObj) {
    var set = {};
    var ds = loreObj.dirs || [];
    for (var i = 0; i < ds.length; i++) {
      var cur = ds[i];
      while (cur) {
        set[cur] = true;
        var idx = cur.lastIndexOf('/');
        if (idx < 0) break;
        cur = cur.slice(0, idx);
      }
    }
    return set;
  }

  function setHighlight(loreIds, dirPaths, active) {
    highlightActive = active;
    highlightLoreIds = active ? loreIds : {};

    for (var id in cardEls) {
      var el = cardEls[id];
      el.classList.remove('hl', 'dim');
      if (active) el.classList.add(loreIds[id] ? 'hl' : 'dim');
    }
    for (var r = 0; r < regionNodes.length; r++) {
      var rel = regionEls[regionNodes[r].id];
      if (!rel) continue;
      rel.classList.remove('dim');
      if (active) {
        var any = false;
        for (var m = 0; m < regionNodes[r].leafIds.length; m++) {
          if (loreIds[regionNodes[r].leafIds[m]]) { any = true; break; }
        }
        if (!any) rel.classList.add('dim');
      }
    }
    dirTreeBody.classList.toggle('hl-active', active);
    for (var p in dirNodeEls) {
      var row = dirNodeEls[p].row;
      row.classList.remove('hl');
      if (active && dirPaths[p]) row.classList.add('hl');
    }
  }

  function hoverDir(path) {
    if (!highlightEnabled) return;
    setHighlight(loreForDir(path), (function () { var o = {}; o[path] = true; return o; })(), true);
  }

  function hoverLore(loreObj) {
    if (!highlightEnabled) return;
    var dirs = dirsForLore(loreObj);
    for (var p in dirs) expandTo(p);
    // Obsidian-style: light up the node plus its 1-hop similarity neighborhood.
    var ids = {}; ids[loreObj.id] = true;
    var adj = loreAdj[loreObj.id] || {};
    for (var nid in adj) ids[nid] = true;
    setHighlight(ids, dirs, true);
  }

  function hoverRegion(region) {
    if (!highlightEnabled) return;
    var ids = {};
    var dirs = {};
    for (var i = 0; i < region.leafIds.length; i++) {
      var id = region.leafIds[i];
      ids[id] = true;
      var L = loreById[id];
      if (!L) continue;
      var ds = dirsForLore(L);
      for (var p in ds) dirs[p] = true;
    }
    for (var q in dirs) expandTo(q);
    setHighlight(ids, dirs, true);
  }

  function clearHighlight() { setHighlight({}, {}, false); }

  // ── popover detail ─────────────────────────────────────────────────────────
  function selectLore(id, clientX, clientY) {
    selectedId = id;
    for (var cid in cardEls) cardEls[cid].classList.toggle('selected', cid === id);
    showPopover(loreById[id], clientX, clientY);
  }

  function showPopover(node, clientX, clientY) {
    if (!node) return;

    var pathsHTML = '';
    for (var i = 0; i < node.paths.length; i++) {
      pathsHTML += '<code>' + esc(node.paths[i]) + '</code><br>';
    }

    popoverContent.innerHTML =
      '<div class="detail-kind ' + node.kind + '">' + esc(node.kind) + '</div>' +
      '<h1 class="detail-title">' + esc(node.title) + '</h1>' +
      '<div class="detail-meta-list">' +
        '<div class="detail-meta-item"><div class="detail-meta-label">Author</div>' +
          '<div class="detail-meta-value">' + esc(node.by) + '</div></div>' +
        (node.date ? '<div class="detail-meta-item"><div class="detail-meta-label">Date</div>' +
          '<div class="detail-meta-value">' + esc(node.date) + '</div></div>' : '') +
        (node.commit ? '<div class="detail-meta-item"><div class="detail-meta-label">Commit</div>' +
          '<div class="detail-meta-value"><code>' + esc(node.commit) + '</code></div></div>' : '') +
        '<div class="detail-meta-item"><div class="detail-meta-label">Paths</div>' +
          '<div class="detail-meta-value">' + pathsHTML + '</div></div>' +
      '</div>' +
      '<div class="detail-body">' + esc(node.body) + '</div>';

    popover.classList.remove('hidden');

    // Anchor near the click, clamped to the viewport.
    var pw = popover.offsetWidth || 340;
    var ph = popover.offsetHeight || 300;
    var x = clientX + 16;
    var y = clientY - 20;
    if (x + pw > window.innerWidth - 16) x = clientX - pw - 16;
    if (x < 16) x = 16;
    if (y + ph > window.innerHeight - 16) y = window.innerHeight - ph - 16;
    if (y < 72) y = 72;
    popover.style.left = x + 'px';
    popover.style.top = y + 'px';
  }

  function hidePopover() {
    popover.classList.add('hidden');
    selectedId = null;
    for (var cid in cardEls) cardEls[cid].classList.remove('selected');
  }

  // ── pan / zoom ─────────────────────────────────────────────────────────────
  function setupPanZoom() {
    wfView.addEventListener('mousedown', function (e) {
      if (e.target.closest('.g-node')) return;
      isPanning = true;
      lastMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mousemove', function (e) {
      if (dragNode) {
        var dx = (e.clientX - lastMouse.x) / transform.k;
        var dy = (e.clientY - lastMouse.y) / transform.k;
        dragNode.x += dx;
        dragNode.y += dy;
        if (Math.abs(e.clientX - lastMouse.x) + Math.abs(e.clientY - lastMouse.y) > 2) dragMoved = true;
        lastMouse = { x: e.clientX, y: e.clientY };
        alpha = Math.max(alpha, 0.35);   // reheat the sim while dragging
        return;
      }
      if (!isPanning) return;
      transform.x += e.clientX - lastMouse.x;
      transform.y += e.clientY - lastMouse.y;
      lastMouse = { x: e.clientX, y: e.clientY };
    });

    window.addEventListener('mouseup', function () {
      isPanning = false;
      dragNode = null;
    });

    wfView.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = Math.pow(2, -e.deltaY * 0.005);
      var newK = clamp(transform.k * factor, 0.1, 3);
      var rect = wfView.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      transform.x = mx - (mx - transform.x) * (newK / transform.k);
      transform.y = my - (my - transform.y) * (newK / transform.k);
      transform.k = newK;
    }, { passive: false });

    wfView.addEventListener('click', function (e) {
      if (e.target === wfView || e.target === gridBg || e.target === edgeCanvas) hidePopover();
    });
  }

  function zoomFit() {
    if (!simNodes.length) return;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < simNodes.length; i++) {
      var n = simNodes[i];
      var hw = (n.w || n.r * 2) / 2, hh = (n.h || n.r * 2) / 2;
      if (n.x - hw < minX) minX = n.x - hw;
      if (n.x + hw > maxX) maxX = n.x + hw;
      if (n.y - hh < minY) minY = n.y - hh;
      if (n.y + hh + 20 > maxY) maxY = n.y + hh + 20;   // room for labels
    }

    var pad = 60;
    var gw = Math.max(1, maxX - minX), gh = Math.max(1, maxY - minY);
    var targetK = clamp(Math.min((width - pad * 2) / gw, (height - pad * 2) / gh), 0.1, 1);
    var tx = width / 2 - ((minX + maxX) / 2) * targetK;
    var ty = height / 2 - ((minY + maxY) / 2) * targetK;
    animateTransform(tx, ty, targetK);
  }

  function animateTransform(tx, ty, tk) {
    var sx = transform.x, sy = transform.y, sk = transform.k, st = now();
    var dur = 450;
    function step() {
      var t = Math.min(1, (now() - st) / dur);
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      transform.x = sx + (tx - sx) * e;
      transform.y = sy + (ty - sy) * e;
      transform.k = sk + (tk - sk) * e;
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  // ── grouping mode (area | author) ──────────────────────────────────────────
  var btnGroupArea = document.getElementById('btn-group-area');
  var btnGroupAuthor = document.getElementById('btn-group-author');

  function syncGroupBtns() {
    if (btnGroupArea) btnGroupArea.classList.toggle('active', groupMode === 'area');
    if (btnGroupAuthor) btnGroupAuthor.classList.toggle('active', groupMode === 'author');
  }

  function setGroupMode(mode) {
    if (mode === groupMode) return;
    groupMode = mode;
    try { localStorage.setItem('scarmap:group', mode); } catch (e) { /* ignore */ }
    clearHighlight();
    hidePopover();
    setupGraph();
    createGraphNodes();
    syncGroupBtns();
    renderStats();
  }

  function renderStats() {
    if (!statsEl) return;
    if (groupMode === 'author') {
      // Weighted leaderboard: severity × freshness, so a fresh mistake
      // outranks a stale decision.
      var score = {};
      var display = {};
      var count = {};
      for (var i = 0; i < lore.length; i++) {
        var L = lore[i];
        var raw = String(L.by || '').trim();
        var key = raw.toLowerCase() || 'unknown';
        if (!(key in display)) display[key] = raw || 'unknown';
        score[key] = (score[key] || 0) + (L.kindWeight || 1) * (L.decayFactor || 0.7);
        count[key] = (count[key] || 0) + 1;
      }
      var keys = Object.keys(score).sort(function (a, b) { return score[b] - score[a]; });
      var top = [];
      for (var t = 0; t < keys.length && t < 3; t++) {
        top.push(esc(display[keys[t]]) + ' ' + count[keys[t]]);
      }
      statsEl.innerHTML =
        lore.length + ' scars · ' + keys.length + ' author' + (keys.length !== 1 ? 's' : '') +
        (top.length ? ' · top: ' + top.join(' · ') : '');
    } else {
      var dirCount = Object.keys(heat).length;
      statsEl.innerHTML = lore.length + ' scars · ' + dirCount + ' scarred dirs';
    }
  }

  // ── buttons ────────────────────────────────────────────────────────────────
  function syncHighlightBtn() {
    if (!btnHighlight) return;
    btnHighlight.classList.toggle('off', !highlightEnabled);
    btnHighlight.title = highlightEnabled
      ? 'Hover highlight (on) — click to disable'
      : 'Hover highlight (off) — click to enable';
  }

  function setupButtons() {
    if (btnZoomIn) btnZoomIn.addEventListener('click', function () { transform.k = clamp(transform.k * 1.2, 0.1, 3); });
    if (btnZoomOut) btnZoomOut.addEventListener('click', function () { transform.k = clamp(transform.k / 1.2, 0.1, 3); });
    if (btnZoomFit) btnZoomFit.addEventListener('click', zoomFit);
    if (btnClosePopover) btnClosePopover.addEventListener('click', hidePopover);

    if (btnTheme) btnTheme.addEventListener('click', function () {
      theme = theme === 'dark' ? 'light' : 'dark';
      // Everything in the dir tree is CSS-var driven — no JS recolor needed.
      document.documentElement.setAttribute('data-theme', theme);
    });

    if (btnCamera) btnCamera.addEventListener('click', exportPNG);

    if (btnGroupArea) btnGroupArea.addEventListener('click', function () { setGroupMode('area'); });
    if (btnGroupAuthor) btnGroupAuthor.addEventListener('click', function () { setGroupMode('author'); });

    if (btnHighlight) {
      syncHighlightBtn();
      btnHighlight.addEventListener('click', function () {
        highlightEnabled = !highlightEnabled;
        try { localStorage.setItem('scarmap:highlight', highlightEnabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
        if (!highlightEnabled) clearHighlight();
        syncHighlightBtn();
      });
    }

    window.addEventListener('keydown', function (e) { if (e.key === 'Escape') hidePopover(); });
  }

  // ── resize / loop ────────────────────────────────────────────────────────
  function doResize() {
    dpr = window.devicePixelRatio || 1;
    width = wfView.clientWidth;
    height = wfView.clientHeight;
    edgeCanvas.width = width * dpr;
    edgeCanvas.height = height * dpr;
    edgeCanvas.style.width = width + 'px';
    edgeCanvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function renderLoop() {
    simTick();
    updateNodePositions();
    renderEdges();
    requestAnimationFrame(renderLoop);
  }

  // ── utilities ────────────────────────────────────────────────────────────
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function now() { return (window.performance && performance.now) ? performance.now() : +new Date(); }
  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── PNG export ─────────────────────────────────────────────────────────────
  // Composites the current view (grid + edges + nodes + watermark) straight
  // onto a canvas. No foreignObject/SVG — that taints the canvas over file://
  // and toBlob() would throw. Pure 2D drawing keeps the export offline & safe.
  var SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  var MONO = "'SF Mono', 'Fira Code', 'Cascadia Code', monospace";

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = (v || '').trim();
    return v || fallback;
  }

  function roundRectPath(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (c.roundRect) { c.beginPath(); c.roundRect(x, y, w, h, r); return; }
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function truncateToWidth(c, text, maxW) {
    text = String(text);
    if (c.measureText(text).width <= maxW) return text;
    var t = text;
    while (t.length && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  /** Word-wrap into at most maxLines lines; ellipsize the last if it overflows. */
  function wrapClamp(c, text, maxW, maxLines) {
    var words = String(text).replace(/\s+/g, ' ').trim().split(' ');
    var lines = [];
    var cur = '';
    var i = 0;
    for (; i < words.length; i++) {
      var test = cur ? cur + ' ' + words[i] : words[i];
      if (c.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = words[i];
        if (lines.length === maxLines) break;
      } else {
        cur = test;
      }
    }
    var consumedAll = false;
    if (lines.length < maxLines) {
      if (cur) lines.push(cur);
      consumedAll = (i >= words.length);
    }
    if (!consumedAll && lines.length) {
      var last = lines[lines.length - 1];
      while (last.length && c.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      lines[lines.length - 1] = last + '…';
    }
    return lines;
  }

  function drawLoreCard(c, n, col) {
    var L = n.lore;
    var cw = n.w || 260;
    var ch = n.h || 150;
    var x = n.x - cw / 2, y = n.y - ch / 2;

    // panel
    roundRectPath(c, x, y, cw, ch, 10);
    c.fillStyle = col.panel; c.fill();
    c.lineWidth = 1; c.strokeStyle = col.border; c.stroke();

    var kindColor = cssVar('--' + L.kind, col.textDim);
    var padX = 12;
    var innerW = cw - padX * 2;

    // header: kind chip + title
    var headerH = 34;
    roundRectPath(c, x + padX, y + 12, 10, 10, 3);
    c.fillStyle = kindColor; c.fill();
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.font = '600 12.5px ' + SANS;
    c.fillStyle = col.text;
    var title = String(L.title || '').replace(/\b\w/g, function (m) { return m.toUpperCase(); });
    c.fillText(truncateToWidth(c, title, innerW - 18), x + padX + 18, y + 17);
    c.strokeStyle = col.border; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, y + headerH); c.lineTo(x + cw, y + headerH); c.stroke();

    // badges
    var by = y + headerH + 10;
    var bx = x + padX;
    var badges = [{ text: L.kind, kind: L.kind }, { text: L.decay, decay: true }];
    c.textBaseline = 'middle';
    for (var b = 0; b < badges.length; b++) {
      var bd = badges[b];
      if (!bd.text) continue;
      c.font = '600 9px ' + SANS;
      var label = String(bd.text).toUpperCase();
      var tw = c.measureText(label).width;
      var bw = tw + 14, bh = 15;
      roundRectPath(c, bx, by, bw, bh, 4);
      if (bd.kind) {
        c.fillStyle = cssVar('--' + bd.kind + '-tint', col.surface); c.fill();
        c.strokeStyle = cssVar('--' + bd.kind, col.border); c.lineWidth = 1; c.stroke();
        c.fillStyle = cssVar('--' + bd.kind, col.text);
      } else {
        c.fillStyle = col.surface; c.fill();
        c.setLineDash([3, 2]);
        c.strokeStyle = col.border; c.lineWidth = 1; c.stroke();
        c.setLineDash([]);
        c.fillStyle = col.muted;
      }
      c.fillText(label, bx + 7, by + bh / 2 + 0.5);
      bx += bw + 5;
    }

    // body snippet (up to 3 lines)
    c.textBaseline = 'top';
    c.textAlign = 'left';
    c.font = '11.5px ' + SANS;
    c.fillStyle = col.textDim;
    var lineH = 16.7;
    var textY = by + 15 + 8;
    var lines = wrapClamp(c, L.body || '', innerW, 3);
    for (var li = 0; li < lines.length; li++) {
      c.fillText(lines[li], x + padX, textY + li * lineH);
    }

    // meta row (author left, first path right)
    var metaY = y + ch - 13;
    c.font = '10px ' + SANS;
    c.fillStyle = col.muted;
    c.textBaseline = 'top';
    c.textAlign = 'left';
    c.fillText(truncateToWidth(c, '👤 ' + (L.by || ''), innerW * 0.5), x + padX, metaY);
    var pathLabel = (L.paths && L.paths[0]) ? L.paths[0] : '';
    if (L.paths && L.paths.length > 1) pathLabel += ' +' + (L.paths.length - 1);
    c.textAlign = 'right';
    c.fillText(truncateToWidth(c, '📁 ' + pathLabel, innerW * 0.52), x + cw - padX, metaY);
    c.textAlign = 'left';
  }

  function exportPNG() {
    var scale = 2; // supersample for crisp text
    var W = width, H = height;
    if (!W || !H) return;

    var out = document.createElement('canvas');
    out.width = Math.round(W * scale);
    out.height = Math.round(H * scale);
    var c = out.getContext('2d');
    c.setTransform(scale, 0, 0, scale, 0, 0);

    var col = {
      bg: cssVar('--bg', theme === 'dark' ? '#0f1115' : '#f8fafc'),
      grid: cssVar('--bg-grid', '#1a1d24'),
      panel: cssVar('--bg-panel', '#16181d'),
      surface: cssVar('--surface', '#22252b'),
      border: cssVar('--border', '#2c3038'),
      text: cssVar('--text', '#e2e8f0'),
      textDim: cssVar('--text-dim', '#94a3b8'),
      muted: cssVar('--text-muted', '#64748b'),
      accent: cssVar('--accent', '#3b82f6')
    };

    // background
    c.fillStyle = col.bg;
    c.fillRect(0, 0, W, H);

    // grid dots (screen space), matching the live 24px radial-dot pattern
    var gap = 24 * transform.k;
    if (gap >= 8) {
      c.fillStyle = col.grid;
      var ox = ((transform.x % gap) + gap) % gap;
      var oy = ((transform.y % gap) + gap) % gap;
      for (var gx = ox; gx < W; gx += gap) {
        for (var gy = oy; gy < H; gy += gap) {
          c.fillRect(gx - 0.5, gy - 0.5, 1.2, 1.2);
        }
      }
    }

    // world transform for edges + nodes
    c.save();
    c.translate(transform.x, transform.y);
    c.scale(transform.k, transform.k);

    // edges (no highlight styling — a clean shareable frame)
    for (var e = 0; e < edges.length; e++) {
      var ed = edges[e];
      c.beginPath();
      c.setLineDash(ed.cross ? [5, 5] : []);
      c.moveTo(ed.a.x, ed.a.y);
      c.lineTo(ed.b.x, ed.b.y);
      c.lineWidth = ed.cross ? 1.2 : 1.6;
      c.strokeStyle = EDGE_COLORS[theme];
      c.globalAlpha = ed.cross ? 0.75 : 1;
      c.stroke();
    }
    c.setLineDash([]);
    c.globalAlpha = 1;

    // dots first (root + regions), then lore cards on top
    for (var i = 0; i < simNodes.length; i++) {
      var n = simNodes[i];
      if (n.type === 'lore') continue;
      c.beginPath();
      c.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      if (n.type === 'root') {
        c.fillStyle = col.accent; c.fill();
      } else {
        c.fillStyle = col.surface; c.fill();
        c.lineWidth = 1.5; c.strokeStyle = col.muted; c.stroke();
      }
      c.textAlign = 'center';
      c.textBaseline = 'top';
      c.fillStyle = n.type === 'root' ? col.text : col.textDim;
      c.font = (n.type === 'root' ? '700 12px ' : '11px ') + MONO;
      var lbl = n.type === 'region' ? (n.label + '  ' + n.leafIds.length) : n.label;
      c.fillText(lbl, n.x, n.y + n.r + 5);
      c.textAlign = 'left';
    }
    for (var j = 0; j < simNodes.length; j++) {
      if (simNodes[j].type === 'lore') drawLoreCard(c, simNodes[j], col);
    }

    c.restore();

    // watermark (bottom-right, subtle attribution)
    c.textAlign = 'right';
    c.textBaseline = 'alphabetic';
    c.font = '600 12px ' + MONO;
    c.fillStyle = col.muted;
    var mark = '◆ ' + (data.repoName || 'repo') + ' · npx teamlore scarmap';
    c.fillText(mark, W - 16, H - 14);

    var fname = String(data.repoName || 'scarmap').replace(/[^a-z0-9._-]+/gi, '-') + '-scarmap.png';
    if (out.toBlob) {
      out.toBlob(function (blob) {
        if (!blob) return;
        var url = URL.createObjectURL(blob);
        triggerDownload(url, fname);
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      }, 'image/png');
    } else {
      triggerDownload(out.toDataURL('image/png'), fname);
    }
  }

  function triggerDownload(href, filename) {
    var a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function renderSparseView() {
    var container = document.getElementById('sparse-entries');
    if (!container) return;
    var html = '';
    for (var i = 0; i < lore.length; i++) {
      var n = lore[i];
      html +=
        '<div class="sparse-card">' +
          '<div style="font-weight:600;margin-bottom:8px;text-transform:capitalize;">' +
            '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:var(--' + n.kind + ')"></span>' +
            esc(n.title) +
          '</div>' +
          '<div style="font-size:13px;color:var(--text-dim)">' + esc(n.body) + '</div>' +
        '</div>';
    }
    container.innerHTML = html;
  }

  // ── bootstrap ──────────────────────────────────────────────────────────────
  var statsEl = document.getElementById('stats');
  renderStats();
  syncGroupBtns();

  setupGraph();
  createGraphNodes();
  renderDirTree();
  doResize();
  window.addEventListener('resize', doResize);
  setupPanZoom();
  setupButtons();
  zoomFit();
  requestAnimationFrame(renderLoop);

})();
