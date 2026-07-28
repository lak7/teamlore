'use strict';

const fs = require('fs');
const path = require('path');

const VIEWS  = path.join(__dirname, 'views');

// The signature ANSI Shadow wordmark (same art as the CLI banner); the fire
// gradient is applied in CSS via background-clip so it matches the terminal.
const WORDMARK = require('../wordmark').join('\n');

/**
 * Generate a self-contained HTML file for the scarmap visualization.
 *
 * All CSS and JS are inlined — the resulting file has zero external
 * dependencies and makes no network calls.
 *
 * @param {object} graphData  — the collector payload (lore, tree, heat, …)
 * @param {string} repoName
 * @returns {string} Complete HTML document.
 */
function generateHTML(graphData, repoName) {
  const css    = fs.readFileSync(path.join(VIEWS, 'graph.css'), 'utf8');
  const js     = fs.readFileSync(path.join(VIEWS, 'graph.js'),  'utf8');
  const dataJSON = JSON.stringify(graphData);
  const nameJSON = JSON.stringify(repoName);
  const safeTitle = escapeHTML(repoName);

  return [
    '<!DOCTYPE html>',
    '<html lang="en" data-theme="dark">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>scarmap \u2014 ' + safeTitle + '</title>',
    '<style>',
    css,
    '</style>',
    '</head>',
    '<body>',
    '',
    '<div id="workflow-view">',
    '  <div class="grid-bg" id="grid-bg"></div>',
    '  <canvas id="edge-canvas"></canvas>',
    '  <div id="node-cards"></div>',
    '  <div id="zoom-controls">',
    '    <button id="btn-zoom-in">+</button>',
    '    <button id="btn-zoom-out">-</button>',
    '    <button id="btn-zoom-fit">\u2317</button>',
    '  </div>',
    '</div>',
    '',
    '<aside id="dir-tree">',
    '  <div class="dir-tree-header">',
    '    <span class="dir-tree-title">Project structure</span>',
    '    <span class="dir-tree-hint">scarred paths marked</span>',
    '    <div class="dir-tree-legend">',
    '      <span class="legend-item"><span class="legend-dot mistake"></span>mistake</span>',
    '      <span class="legend-item"><span class="legend-dot gotcha"></span>gotcha</span>',
    '      <span class="legend-item"><span class="legend-dot decision"></span>decision</span>',
    '    </div>',
    '  </div>',
    '  <div id="dir-tree-body"></div>',
    '</aside>',
    '',
    '<div id="toolbar">',
    '  <div id="group-toggle" class="seg" title="Group lore by">',
    '    <button class="seg-btn active" id="btn-group-area" title="Group by code area">\ud83d\udcc1 area</button>',
    '    <button class="seg-btn" id="btn-group-author" title="Group by author">\ud83d\udc64 author</button>',
    '  </div>',
    '  <button class="toolbar-btn" id="btn-highlight" title="Hover highlight (on)">\u2726</button>',
    '  <button class="toolbar-btn" id="btn-camera" title="Save as PNG">\ud83d\udcf7</button>',
    '  <button class="toolbar-btn" id="btn-theme" title="Toggle theme">\ud83c\udf19</button>',
    '</div>',
    '',
    '<div id="lore-popover" class="hidden">',
    '  <button class="btn-close" id="btn-close-popover">\u00d7</button>',
    '  <div id="popover-content"></div>',
    '</div>',
    '',
    '<div id="sparse-view" class="hidden">',
    '  <div class="sparse-header">',
    '    <h1>\u25c6 scarmap</h1>',
    '    <p>Your scarmap grows with your team\u2019s lore. Add a few more entries to unlock the full workflow view.</p>',
    '  </div>',
    '  <div id="sparse-entries" class="sparse-entries"></div>',
    '</div>',
    '',
    '<div class="logo">',
    '  <a href="https://github.com/lak7/teamlore" target="_blank" rel="noopener" title="teamlore — break things only once"><pre class="logo-mark">' + WORDMARK + '</pre></a>',
    '  <div class="logo-sub">scarmap · break things only once.</div>',
    '</div>',
    '',
    '<div class="stats" id="stats"></div>',
    '',
    '<script>',
    'var GRAPH_DATA=' + dataJSON + ';',
    'var REPO_NAME=' + nameJSON + ';',
    js,
    '</' + 'script>',
    '',
    '</body>',
    '</html>',
  ].join('\n');
}

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { generateHTML };
