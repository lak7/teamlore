'use strict';

/*
 * Zero-dependency terminal styling for the teamlore CLI.
 *
 * Colors are emitted only to a real TTY (and never when NO_COLOR is set),
 * so piped / redirected output stays clean. A truecolor gradient is used for
 * the wordmark when the terminal advertises 24-bit color, with graceful
 * fallbacks to a single accent color and then to plain text.
 */

const env = process.env;
const NO_COLOR = 'NO_COLOR' in env;
const FORCE = env.FORCE_COLOR;
const useColor = !NO_COLOR && (FORCE ? FORCE !== '0' : !!process.stdout.isTTY);
const truecolor =
  useColor && (/(truecolor|24bit)/i.test(env.COLORTERM || '') || FORCE === '3');

// --- primitives -----------------------------------------------------------

function sgr(open, close) {
  return (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
}

const bold = sgr(1, 22);
const dim = sgr(2, 22);
const italic = sgr(3, 23);

// 24-bit fg with a 256/16-color-ish fallback (we just fall back to plain when
// truecolor is unavailable to avoid muddy approximations).
function ink(r, g, b) {
  return (s) =>
    truecolor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : useColor ? `\x1b[${b > 128 || g > 128 ? 36 : 35}m${s}\x1b[39m` : String(s);
}

// Brand palette
const violet = ink(139, 122, 255);
const pink = ink(236, 110, 173);
const green = ink(52, 211, 153);
const cyan = ink(103, 205, 224);
const amber = ink(245, 191, 96);
const gray = (s) => dim(s);

// --- gradient wordmark ----------------------------------------------------

const STOPS = [
  [124, 132, 255], // indigo
  [168, 120, 245], // violet
  [236, 110, 173], // pink
  [245, 170, 120], // warm amber tail
];

// Fire gradient (top → bottom): yellow-hot tips down to deep-orange embers.
const FIRE = [
  [255, 241, 120], // bright yellow
  [255, 197, 66], // golden
  [255, 148, 34], // orange
  [233, 86, 20], // deep orange
  [201, 46, 15], // ember red-orange
];

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function sample(stops, t) {
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

// Render text with a per-character horizontal gradient (bold).
function gradient(text) {
  const chars = Array.from(text);
  if (!useColor) return text;
  if (!truecolor) return bold(violet(text));
  const n = chars.length;
  let out = '\x1b[1m';
  chars.forEach((ch, i) => {
    if (ch === ' ') {
      out += ' ';
      return;
    }
    const [r, g, b] = sample(STOPS, n <= 1 ? 0 : i / (n - 1));
    out += `\x1b[38;2;${r};${g};${b}m${ch}`;
  });
  out += '\x1b[39m\x1b[22m';
  return out;
}

// The big ASCII wordmark with a vertical fire gradient (one hue per row).
function bigWordmark() {
  const art = require('./wordmark');
  const rows = art.length;
  if (!useColor) return art.map((l) => '  ' + l).join('\n');
  if (!truecolor) return art.map((l) => '  \x1b[33m' + l + '\x1b[39m').join('\n');
  return art
    .map((l, i) => {
      const [r, g, b] = sample(FIRE, rows <= 1 ? 0 : i / (rows - 1));
      return `  \x1b[1m\x1b[38;2;${r};${g};${b}m${l}\x1b[39m\x1b[22m`;
    })
    .join('\n');
}

// Width the big wordmark needs (art width + left margin).
const BIG_WIDTH = 72;

// --- helpers --------------------------------------------------------------

function padEnd(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

const symbols = {
  ok: green('✓'),
  skip: gray('○'),
  spark: amber('✦'),
  diamond: '◆',
  arrow: gray('→'),
  dot: dim('·'),
};

function rule(width) {
  return dim('─'.repeat(width));
}

// The teamlore wordmark block, shared by `init`, `remove`, and `--help`.
// Uses the big fire-gradient ASCII art when the terminal is wide enough,
// falling back to the compact spaced wordmark on narrow terminals.
function banner(v) {
  const cols = process.stdout.columns || Number(process.env.COLUMNS) || 0;
  const wide = cols === 0 || cols >= BIG_WIDTH;
  const mark = wide
    ? bigWordmark()
    : '  ' + gradient('◆') + '  ' + gradient('t e a m l o r e');
  const indent = wide ? '     ' : '     ';
  return (
    '\n' +
    mark +
    '\n' +
    indent +
    dim("shared memory for your team's Claude Code") +
    (v ? '  ' + symbols.dot + '  ' + dim('v' + v) : '') +
    '\n'
  );
}

module.exports = {
  useColor,
  truecolor,
  bold,
  dim,
  italic,
  violet,
  pink,
  green,
  cyan,
  amber,
  gray,
  gradient,
  padEnd,
  symbols,
  rule,
  banner,
};
