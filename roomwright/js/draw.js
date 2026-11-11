// Drawing the plan sheet: grid, room, furniture symbols, openings, handles and dimensions.
// Also draws the small catalog icons, which reuse the same symbols.

import { FOOT, formatLength } from './units.js';
import { WALL_THICKNESS as T, distance, itemCorners } from './geometry.js';
import { ITEM_DEFS } from './catalog.js';
import { app, getWalls, wallColor, findSelected, findIssues, itemsInDrawOrder, toWorld, toScreen, fitView, requestDraw } from './state.js';

let canvas, ctx, sheet;
let pixelRatio = 1;
let hasFitted = false;
/** Theme colours read from the CSS custom properties in styles.css. */
const colors = {};

export function initCanvas(canvasElement, sheetElement) {
  canvas = canvasElement;
  sheet = sheetElement;
  ctx = canvas.getContext('2d');
  refreshTheme();
  new ResizeObserver(resize).observe(sheet);
  resize();
  // Redraw when the theme changes or the web fonts arrive.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshTheme);
  new MutationObserver(refreshTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(requestDraw);
}

export function refreshTheme() {
  const style = getComputedStyle(document.documentElement);
  for (const name of ['paper', 'ink', 'ink-2', 'grid', 'grid-major', 'accent', 'accent-ink', 'warn']) {
    colors[name] = style.getPropertyValue('--' + name).trim();
  }
  drawCatalogTiles();
  requestDraw();
}

function resize() {
  const box = sheet.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return;
  app.view.width = box.width;
  app.view.height = box.height;
  pixelRatio = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(box.width * pixelRatio);
  canvas.height = Math.round(box.height * pixelRatio);
  if (!hasFitted) { hasFitted = true; fitView(); }
  requestDraw();
}

/* ------------------------------------------------------------------ material patterns */

// Each pattern is a small transparent tile of light and dark marks. It is painted over a
// shape that is already filled with the item's colour, so one pattern works for any colour.
// Entry: [tile size in metres, function that paints the tile (context, tile pixels, random)].

/** Small seeded random generator, so patterns look the same on every load. */
function seededRandom(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lightOrDark = random => (random() < 0.5 ? '255,255,255' : '0,0,0');

const PATTERNS = {
  wood: [0.55, (c, n, random) => {
    for (let i = 0; i < 26; i++) {
      const y = random() * n, wobble = random() * 2.5, waves = 1 + Math.floor(random() * 2), phase = random() * 6;
      c.strokeStyle = `rgba(40,20,5,${0.08 + random() * 0.2})`;
      c.lineWidth = 0.6 + random() * 1.6;
      c.beginPath();
      for (let x = 0; x <= n; x += 6) c.lineTo(x, y + Math.sin((x / n) * 6.283 * waves + phase) * wobble);
      c.stroke();
    }
  }],
  planks: [1.2, (c, n, random) => {
    const rows = 8, rowHeight = n / rows;
    for (let i = 0; i < rows; i++) {
      c.fillStyle = `rgba(${random() < 0.5 ? '255,255,255' : '40,20,5'},${random() * 0.12})`;
      c.fillRect(0, i * rowHeight, n, rowHeight);
      c.fillStyle = 'rgba(30,15,5,.4)';
      c.fillRect(0, i * rowHeight, n, 1);                               // gap between rows
      c.fillRect(Math.floor(random() * n), i * rowHeight, 1, rowHeight); // butt joint
      for (let j = 0; j < 3; j++) {
        c.fillStyle = `rgba(40,20,5,${0.05 + random() * 0.1})`;
        c.fillRect(0, i * rowHeight + 2 + random() * (rowHeight - 4), n, 0.8);
      }
    }
  }],
  tile: [1.2, (c, n) => {
    c.fillStyle = 'rgba(30,30,30,.32)';
    for (const p of [0, n / 2]) { c.fillRect(p, 0, 1.5, n); c.fillRect(0, p, n, 1.5); }
  }],
  carpet: [0.35, (c, n, random) => {
    for (let i = 0; i < 700; i++) {
      c.fillStyle = `rgba(${lightOrDark(random)},${0.05 + random() * 0.12})`;
      c.fillRect(random() * n, random() * n, 1.4, 1.4);
    }
  }],
  concrete: [1.6, (c, n, random) => {
    for (let i = 0; i < 40; i++) {
      const x = random() * n, y = random() * n, radius = 6 + random() * 22, tone = lightOrDark(random);
      // Draw each blotch nine times so it wraps cleanly across tile edges.
      for (const dx of [-n, 0, n]) for (const dy of [-n, 0, n]) {
        const gradient = c.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, radius);
        gradient.addColorStop(0, `rgba(${tone},.09)`);
        gradient.addColorStop(1, `rgba(${tone},0)`);
        c.fillStyle = gradient;
        c.fillRect(x + dx - radius, y + dy - radius, 2 * radius, 2 * radius);
      }
    }
  }],
  fabric: [0.16, (c, n) => {
    c.fillStyle = 'rgba(0,0,0,.13)';
    for (let i = 0; i < n; i += 8) for (let j = 0; j < n; j += 8) { c.fillRect(i, j, 4, 4); c.fillRect(i + 4, j + 4, 4, 4); }
    c.fillStyle = 'rgba(255,255,255,.1)';
    for (let i = 0; i < n; i += 8) for (let j = 0; j < n; j += 8) c.fillRect(i + 4, j, 4, 4);
  }],
  leather: [0.4, (c, n, random) => {
    for (let i = 0; i < 60; i++) {
      c.strokeStyle = `rgba(0,0,0,${0.06 + random() * 0.1})`;
      c.lineWidth = 0.8;
      c.beginPath();
      const start = random() * 6;
      c.arc(random() * n, random() * n, 2 + random() * 5, start, start + 2);
      c.stroke();
    }
  }],
  metal: [0.3, (c, n, random) => {
    for (let i = 0; i < 50; i++) {
      c.fillStyle = `rgba(${lightOrDark(random)},${0.05 + random() * 0.12})`;
      c.fillRect(0, random() * n, n, 0.8);
    }
  }],
  stone: [0.9, (c, n, random) => {
    for (let i = 0; i < 6; i++) {
      c.strokeStyle = `rgba(40,40,50,${0.12 + random() * 0.2})`;
      c.lineWidth = 0.6 + random();
      c.beginPath();
      let x = random() * n, y = 0;
      c.moveTo(x, y);
      while (y < n) { x += (random() - 0.5) * 22; y += 6 + random() * 12; c.lineTo(x, y); }
      c.stroke();
    }
  }],
  shag: [0.22, (c, n, random) => {
    for (let i = 0; i < 420; i++) {
      c.strokeStyle = `rgba(${lightOrDark(random)},${0.08 + random() * 0.16})`;
      c.lineWidth = 1;
      const x = random() * n, y = random() * n, angle = random() * 6.3;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(angle) * 5, y + Math.sin(angle) * 5); c.stroke();
    }
  }],
};
PATTERNS.weave = PATTERNS.fabric;

const patternCache = {};
/** A canvas pattern for a material, scaled to real-world size, or null if the material is plain. */
function patternFor(material) {
  if (material in patternCache) return patternCache[material];
  const entry = PATTERNS[material];
  if (!entry) return (patternCache[material] = null);
  const [sizeInMeters, paint] = entry;
  const pixels = 96;
  const tile = document.createElement('canvas');
  tile.width = tile.height = pixels;
  paint(tile.getContext('2d'), pixels, seededRandom(material.length * 7919 + material.charCodeAt(0)));
  const pattern = ctx.createPattern(tile, 'repeat');
  try { pattern.setTransform(new DOMMatrix().scale(sizeInMeters / pixels)); } catch (e) { return (patternCache[material] = null); }
  return (patternCache[material] = pattern);
}

/** Lighten (amount > 0) or darken (amount < 0) a hex colour. amount is -1..1. */
function shade(hex, amount) {
  const value = parseInt(hex.slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const k = Math.abs(amount);
  const channel = shift => Math.round(((value >> shift) & 255) * (1 - k) + target * k);
  return '#' + ((1 << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0)).toString(16).slice(1);
}

/* ------------------------------------------------------------------ path helpers */

function roundedRect(c, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function ellipse(c, x, y, radiusX, radiusY) {
  c.beginPath();
  c.ellipse(x, y, Math.max(0.001, radiusX), Math.max(0.001, radiusY), 0, 0, Math.PI * 2);
}
/** Stroke one or more separate line segments: lines(c, x1, y1, x2, y2, x1, y1, x2, y2, ...). */
function lines(c, ...coords) {
  c.beginPath();
  for (let i = 0; i < coords.length; i += 4) { c.moveTo(coords[i], coords[i + 1]); c.lineTo(coords[i + 2], coords[i + 3]); }
  c.stroke();
}
/** Fill the current path with the fill colour, lay the material pattern over it, then outline it. */
function fillAndStroke(c, pattern) {
  c.fill();
  if (pattern) { const colour = c.fillStyle; c.fillStyle = pattern; c.fill(); c.fillStyle = colour; }
  c.stroke();
}

/* ------------------------------------------------------------------ furniture symbols */

// One function per catalog `kind`. Each draws in metres, centred on the origin, with the
// front of the piece toward +y. Arguments: context, width, depth, material pattern (or null),
// the item, and `px` (the size of one screen pixel in metres, for hairline details).
const SYMBOLS = {
  sofa(c, w, d, pattern, item) {
    const arm = Math.min(0.17, w * 0.15), back = Math.min(0.22, d * 0.27);
    roundedRect(c, -w / 2, -d / 2, w, d, 0.07); fillAndStroke(c, pattern);
    const base = c.fillStyle;
    c.fillStyle = shade(item.color, 0.14);
    roundedRect(c, -w / 2 + arm, -d / 2 + back, w - 2 * arm, d - back - 0.02, 0.05); fillAndStroke(c, pattern);
    c.fillStyle = base;
    const cushions = Math.max(1, Math.round((w - 2 * arm) / 0.75));
    for (let i = 1; i < cushions; i++) {
      const x = -w / 2 + arm + ((w - 2 * arm) * i) / cushions;
      lines(c, x, -d / 2 + back, x, d / 2 - 0.02);
    }
  },
  chair(c, w, d, pattern, item) {
    roundedRect(c, -w / 2, -d / 2 + d * 0.1, w, d * 0.9, 0.05); fillAndStroke(c, pattern);
    const base = c.fillStyle;
    c.fillStyle = shade(item.color, -0.2);
    roundedRect(c, -w / 2, -d / 2, w, d * 0.17, 0.03); fillAndStroke(c);
    c.fillStyle = base;
  },
  office(c, w, d, pattern, item, px) {
    ellipse(c, 0, d * 0.04, w * 0.4, d * 0.4); fillAndStroke(c, pattern);
    const lineWidth = c.lineWidth;
    c.lineWidth = Math.max(0.05, 3 * px);
    c.beginPath(); c.ellipse(0, 0, w * 0.47, d * 0.47, 0, Math.PI * 1.17, Math.PI * 1.83); c.stroke();
    c.lineWidth = lineWidth;
  },
  table(c, w, d, pattern) {
    roundedRect(c, -w / 2, -d / 2, w, d, 0.02); fillAndStroke(c, pattern);
    const inset = Math.min(0.06, w * 0.1, d * 0.1);
    roundedRect(c, -w / 2 + inset, -d / 2 + inset, w - 2 * inset, d - 2 * inset, 0.01); c.stroke();
  },
  rtable(c, w, d, pattern) {
    ellipse(c, 0, 0, w / 2, d / 2); fillAndStroke(c, pattern);
    ellipse(c, 0, 0, w * 0.42, d * 0.42); c.stroke();
  },
  desk(c, w, d, pattern, item) {
    roundedRect(c, -w / 2, -d / 2, w, d, 0.015); fillAndStroke(c, pattern);
    const drawers = Math.min(0.42, w * 0.32);
    const base = c.fillStyle;
    c.fillStyle = shade(item.color, -0.1);
    roundedRect(c, w / 2 - drawers - 0.03, -d / 2 + 0.04, drawers, d - 0.08, 0.01); fillAndStroke(c);
    c.fillStyle = base;
  },
  shelf(c, w, d, pattern) {
    roundedRect(c, -w / 2, -d / 2, w, d, 0.005); fillAndStroke(c, pattern);
    const bays = Math.max(2, Math.round(w / 0.3));
    for (let i = 1; i < bays; i++) { const x = -w / 2 + (w * i) / bays; lines(c, x, -d / 2, x, d / 2); }
    lines(c, -w / 2, -d / 2 + d * 0.18, w / 2, -d / 2 + d * 0.18);
  },
  chest(c, w, d, pattern, item, px) {
    roundedRect(c, -w / 2, -d / 2, w, d, 0.015); fillAndStroke(c, pattern);
    lines(c, -w / 2, d / 2 - d * 0.16, w / 2, d / 2 - d * 0.16);
    const knobs = w > 0.7 ? 2 : 1, radius = Math.max(0.015, 1.5 * px);
    for (let i = 0; i < knobs; i++) { ellipse(c, -w / 2 + (w * (i + 0.5)) / knobs, d / 2 - d * 0.08, radius, radius); c.stroke(); }
  },
  wardrobe(c, w, d, pattern) {
    roundedRect(c, -w / 2, -d / 2, w, d, 0.01); fillAndStroke(c, pattern);
    lines(c, -w / 2, -d / 2, w / 2, d / 2, -w / 2, d / 2, w / 2, -d / 2);
  },
  media(c, w, d, pattern) {
    roundedRect(c, -w / 2, -d / 2, w, d, 0.015); fillAndStroke(c, pattern);
    const base = c.fillStyle;
    c.fillStyle = '#1d1f24'; // the television
    roundedRect(c, -w * 0.39, -d * 0.12, w * 0.78, Math.max(0.045, d * 0.14), 0.01); c.fill();
    c.fillStyle = base;
  },
  bed(c, w, d, pattern, item) {
    const colour = item.color;
    c.fillStyle = '#f6f4ee'; // sheet
    roundedRect(c, -w / 2, -d / 2, w, d, 0.05); fillAndStroke(c);
    c.fillStyle = colour;    // duvet
    roundedRect(c, -w / 2, -d / 2 + d * 0.36, w, d * 0.64, 0.05); fillAndStroke(c, pattern);
    c.fillStyle = shade(colour, 0.25); // folded-back edge
    roundedRect(c, -w / 2, -d / 2 + d * 0.36, w, d * 0.07, 0.02); fillAndStroke(c);
    c.fillStyle = '#ffffff';
    const pillows = w > 1.3 ? 2 : 1, pillowWidth = (w - 0.14) / pillows - 0.05;
    for (let i = 0; i < pillows; i++) {
      roundedRect(c, -w / 2 + 0.07 + i * (pillowWidth + 0.1) + 0.025, -d / 2 + 0.12, pillowWidth, Math.min(0.42, d * 0.2), 0.06);
      fillAndStroke(c);
    }
    c.fillStyle = shade(colour, -0.25); // headboard
    roundedRect(c, -w / 2, -d / 2, w, 0.07, 0.02); fillAndStroke(c);
    c.fillStyle = colour;
  },
  lamp(c, w, d) {
    const glow = c.createRadialGradient(0, 0, 0, 0, 0, w * 0.95);
    glow.addColorStop(0, 'rgba(255,205,110,.5)');
    glow.addColorStop(1, 'rgba(255,205,110,0)');
    const base = c.fillStyle;
    c.fillStyle = glow; ellipse(c, 0, 0, w * 0.95, d * 0.95); c.fill();
    c.fillStyle = base; ellipse(c, 0, 0, w / 2, d / 2); fillAndStroke(c);
    ellipse(c, 0, 0, w * 0.16, d * 0.16); c.stroke();
    lines(c, -w * 0.16, 0, -w / 2, 0, w * 0.16, 0, w / 2, 0, 0, -d * 0.16, 0, -d / 2, 0, d * 0.16, 0, d / 2);
  },
  rug(c, w, d, pattern, item) {
    roundedRect(c, -w / 2, -d / 2, w, d, 0); fillAndStroke(c, pattern);
    if (item.material === 'stripes') {
      const bands = Math.max(4, Math.round(w / 0.22));
      c.fillStyle = shade(item.color, 0.42);
      for (let i = 0; i < bands; i += 2) c.fillRect(-w / 2 + (w * i) / bands, -d / 2, w / bands, d);
      c.fillStyle = item.color;
      roundedRect(c, -w / 2, -d / 2, w, d, 0); c.stroke();
    }
    if (item.material === 'border') {
      const band = Math.min(0.14, w * 0.09, d * 0.09);
      c.fillStyle = shade(item.color, 0.5);
      roundedRect(c, -w / 2 + band, -d / 2 + band, w - 2 * band, d - 2 * band, 0); fillAndStroke(c);
      c.fillStyle = item.color;
      roundedRect(c, -w / 2 + 2 * band, -d / 2 + 2 * band, w - 4 * band, d - 4 * band, 0); fillAndStroke(c, pattern);
      c.fillStyle = shade(item.color, 0.5); // centre medallion
      const rx = Math.max(0.02, w * 0.16), ry = Math.max(0.02, d * 0.26);
      c.beginPath(); c.moveTo(0, -ry); c.lineTo(rx, 0); c.lineTo(0, ry); c.lineTo(-rx, 0); c.closePath(); fillAndStroke(c);
      c.fillStyle = item.color;
    }
    // Fringe on the two short ends.
    const tassels = Math.max(6, Math.round(d / 0.06)), fringe = Math.min(0.05, w * 0.04);
    c.beginPath();
    for (let i = 0; i <= tassels; i++) {
      const y = -d / 2 + (d * i) / tassels;
      c.moveTo(-w / 2, y); c.lineTo(-w / 2 - fringe, y);
      c.moveTo(w / 2, y); c.lineTo(w / 2 + fringe, y);
    }
    c.stroke();
  },
  rrug(c, w, d, pattern, item) {
    ellipse(c, 0, 0, w / 2, d / 2); fillAndStroke(c, pattern);
    if (item.material === 'stripes' || item.material === 'border') {
      c.fillStyle = shade(item.color, 0.45); ellipse(c, 0, 0, w * 0.4, d * 0.4); fillAndStroke(c);
      c.fillStyle = item.color; ellipse(c, 0, 0, w * 0.3, d * 0.3); fillAndStroke(c, pattern);
    } else {
      ellipse(c, 0, 0, w * 0.42, d * 0.42); c.stroke();
    }
  },
  plant(c, w, d) {
    const pot = c.fillStyle;
    c.fillStyle = '#5f8f5c';
    for (let i = 0; i < 7; i++) {
      const angle = (i / 7) * Math.PI * 2 + 0.3;
      c.beginPath();
      c.ellipse(Math.cos(angle) * w * 0.27, Math.sin(angle) * d * 0.27, w * 0.24, d * 0.12, angle, 0, Math.PI * 2);
      fillAndStroke(c);
    }
    c.fillStyle = pot; ellipse(c, 0, 0, w * 0.22, d * 0.22); fillAndStroke(c);
  },
  box(c, w, d, pattern) {
    roundedRect(c, -w / 2, -d / 2, w, d, 0); fillAndStroke(c, pattern);
    lines(c, -w / 2, -d / 2, w / 2, d / 2, -w / 2, d / 2, w / 2, -d / 2);
  },
};

/** Draw an item's symbol at the origin of the current transform. */
function drawSymbol(c, item, px, withPattern) {
  c.fillStyle = item.color;
  c.strokeStyle = colors.ink;
  c.lineWidth = 1.2 * px;
  c.lineJoin = 'round';
  SYMBOLS[ITEM_DEFS[item.type].kind](c, item.w, item.d, withPattern ? patternFor(item.material) : null, item, px);
}

/** Paint the little previews in the Furnish panel. */
export function drawCatalogTiles() {
  document.querySelectorAll('.tile canvas').forEach(tile => {
    const def = ITEM_DEFS[tile.dataset.type];
    const c = tile.getContext('2d');
    const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
    tile.width = 60 * ratio;
    tile.height = 42 * ratio;
    const item = { type: def.type, w: def.width, d: def.depth, color: def.color, material: def.material };
    const scale = Math.min(52 / (item.w * 1.12), 34 / (item.d * 1.12), 60);
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.clearRect(0, 0, 60, 42);
    c.translate(30, 21);
    c.scale(scale, scale);
    drawSymbol(c, item, 1 / scale, false);
  });
}

/* ------------------------------------------------------------------ the sheet */

/** A small text pill in screen space, rotated to follow a wall and kept right way up. */
function drawLabel(text, x, y, angle, highlighted) {
  ctx.save();
  ctx.translate(x, y);
  if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
  ctx.rotate(angle);
  ctx.font = '500 11px "IBM Plex Mono",ui-monospace,monospace';
  const width = ctx.measureText(text).width + 10;
  ctx.fillStyle = highlighted ? colors.accent : colors.paper;
  ctx.globalAlpha = highlighted ? 1 : 0.9;
  roundedRect(ctx, -width / 2, -9, width, 18, 4); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = highlighted ? colors['accent-ink'] : colors['ink-2'];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0.5);
  ctx.restore();
}

function drawGrid(units) {
  const { view } = app;
  // 1 ft squares with a heavier line every 5 ft, or 0.5 m squares with a heavier line every 2 m.
  const step = units === 'metric' ? 0.5 : FOOT;
  const majorEvery = units === 'metric' ? 4 : 5;
  if (step * view.scale < 7) return;
  const topLeft = toWorld(0, 0), bottomRight = toWorld(view.width, view.height);
  for (const major of [false, true]) {
    ctx.strokeStyle = major ? colors['grid-major'] : colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = Math.floor(topLeft.x / step); i <= bottomRight.x / step; i++) {
      if ((i % majorEvery === 0) !== major) continue;
      const x = Math.round(i * step * view.scale + view.offsetX) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, view.height);
    }
    for (let i = Math.floor(topLeft.y / step); i <= bottomRight.y / step; i++) {
      if ((i % majorEvery === 0) !== major) continue;
      const y = Math.round(i * step * view.scale + view.offsetY) + 0.5;
      ctx.moveTo(0, y); ctx.lineTo(view.width, y);
    }
    ctx.stroke();
  }
}

/**
 * Draw one window, door or outlet. The context is moved so that x runs along the wall from
 * its starting corner, and `side` (+1 or -1) says which way along y the room interior lies.
 */
function drawOpening(opening, wall, px, selected) {
  ctx.save();
  ctx.translate(wall.a.x, wall.a.y);
  ctx.rotate(Math.atan2(wall.uy, wall.ux));
  const side = wall.inwardSign;
  const start = opening.pos - opening.width / 2;
  ctx.strokeStyle = selected ? colors.accent : colors.ink;
  ctx.lineWidth = (selected ? 2.4 : 1.3) * px;
  ctx.fillStyle = colors.paper;
  if (opening.type === 'window') {
    ctx.fillRect(start, -side * T, opening.width, side * T);
    ctx.strokeRect(start, -side * T, opening.width, side * T);
    lines(ctx, start, (-side * T) / 2, start + opening.width, (-side * T) / 2);
  } else if (opening.type === 'door') {
    ctx.fillRect(start, -side * (T + 2 * px), opening.width, side * (T + 4 * px)); // gap in the wall
    lines(ctx, start, -side * T, start, 0, start + opening.width, -side * T, start + opening.width, 0);
    lines(ctx, start, 0, start, side * opening.width); // the door leaf, open into the room
    ctx.setLineDash([4 * px, 3 * px]);
    ctx.beginPath();
    ctx.arc(start, 0, opening.width, side > 0 ? Math.PI / 2 : -Math.PI / 2, 0, side > 0); // its swing
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    const radius = Math.max(0.06, 5.5 * px), y = side * (radius + 3 * px);
    ellipse(ctx, opening.pos, y, radius, radius); ctx.fill(); ctx.stroke();
    lines(ctx, opening.pos - radius * 0.35, y - radius * 0.45, opening.pos - radius * 0.35, y + radius * 0.45,
      opening.pos + radius * 0.35, y - radius * 0.45, opening.pos + radius * 0.35, y + radius * 0.45);
  }
  ctx.restore();
}

/** Redraw the whole sheet from app state. */
export function draw() {
  const { plan, view, selection, tool, draft } = app;
  const px = 1 / view.scale; // one screen pixel, in metres
  const corners = plan.room.verts;
  const walls = getWalls();
  const units = plan.units;
  const selected = findSelected();
  const tracing = tool === 'draw' && draft.points.length > 0;

  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.fillStyle = colors.paper;
  ctx.fillRect(0, 0, view.width, view.height);
  drawGrid(units);

  // Everything in this block is drawn in plan coordinates (metres).
  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);

  // Walls and floor. The wall stroke is twice the wall thickness, centred on the room outline;
  // filling the floor over it leaves only the outer half showing.
  ctx.beginPath();
  corners.forEach((corner, i) => (i ? ctx.lineTo(corner.x, corner.y) : ctx.moveTo(corner.x, corner.y)));
  ctx.closePath();
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;
  ctx.lineWidth = 2 * T;
  ctx.strokeStyle = colors.ink;
  ctx.stroke();
  ctx.fillStyle = plan.room.floor.color;
  ctx.fill();
  const floorPattern = patternFor(plan.room.floor.material);
  if (floorPattern) { ctx.fillStyle = floorPattern; ctx.fill(); }

  // A strip of paint colour along the inside face of each wall.
  ctx.lineCap = 'butt';
  for (const wall of walls) {
    const inset = 2.5 * px;
    ctx.strokeStyle = wallColor(wall.id);
    ctx.lineWidth = 5 * px;
    ctx.beginPath();
    ctx.moveTo(wall.a.x + wall.nx * inset + wall.ux * inset, wall.a.y + wall.ny * inset + wall.uy * inset);
    ctx.lineTo(wall.b.x + wall.nx * inset - wall.ux * inset, wall.b.y + wall.ny * inset - wall.uy * inset);
    ctx.stroke();
  }

  // Furniture, with a red dashed outline on anything overlapping or outside the walls.
  const issues = findIssues();
  for (const item of itemsInDrawOrder()) {
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate((item.rot * Math.PI) / 180);
    drawSymbol(ctx, item, px, true);
    if (issues[item.id]) {
      ctx.strokeStyle = colors.warn;
      ctx.lineWidth = 2.2 * px;
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.strokeRect(-item.w / 2, -item.d / 2, item.w, item.d);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  for (const opening of plan.openings) {
    const wall = walls.find(w => w.id === opening.wall);
    if (wall) drawOpening(opening, wall, px, !!selection && selection.kind === 'opening' && selection.id === opening.id);
  }

  // Selected wall: highlight the wall band.
  if (selection && selection.kind === 'wall') {
    const wall = walls.find(w => w.id === selection.id);
    if (wall) {
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = T;
      ctx.beginPath();
      ctx.moveTo(wall.a.x - (wall.nx * T) / 2, wall.a.y - (wall.ny * T) / 2);
      ctx.lineTo(wall.b.x - (wall.nx * T) / 2, wall.b.y - (wall.ny * T) / 2);
      ctx.stroke();
    }
  }

  // Selected item: outline and rotate handle (the handle's position must match rotateHandlePosition in input.js).
  if (selection && selection.kind === 'item' && selected) {
    const item = selected;
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate((item.rot * Math.PI) / 180);
    ctx.strokeStyle = colors.ink; ctx.lineWidth = 4 * px;
    ctx.strokeRect(-item.w / 2, -item.d / 2, item.w, item.d);
    ctx.strokeStyle = colors.accent; ctx.lineWidth = 2 * px;
    ctx.strokeRect(-item.w / 2, -item.d / 2, item.w, item.d);
    const handleY = item.d / 2 + 24 * px;
    ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.5 * px;
    lines(ctx, 0, item.d / 2, 0, handleY);
    ctx.fillStyle = colors.accent;
    ellipse(ctx, 0, handleY, 6.5 * px, 6.5 * px); ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // Alignment guides while dragging a corner or tracing a room.
  if (draft.guides.length) {
    const topLeft = toWorld(0, 0), bottomRight = toWorld(view.width, view.height);
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = px;
    ctx.setLineDash([5 * px, 4 * px]);
    for (const guide of draft.guides) {
      ctx.beginPath();
      if (guide.x != null) { ctx.moveTo(guide.x, topLeft.y); ctx.lineTo(guide.x, bottomRight.y); }
      else { ctx.moveTo(topLeft.x, guide.y); ctx.lineTo(bottomRight.x, guide.y); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Edit walls: a square handle on each corner and a "+" in the middle of each wall.
  if (tool === 'walls') {
    for (const wall of walls) {
      if (wall.length * view.scale <= 44) continue;
      const x = (wall.a.x + wall.b.x) / 2, y = (wall.a.y + wall.b.y) / 2;
      ctx.fillStyle = colors.paper; ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.2 * px;
      ellipse(ctx, x, y, 6 * px, 6 * px); ctx.fill(); ctx.stroke();
      lines(ctx, x - 3 * px, y, x + 3 * px, y, x, y - 3 * px, x, y + 3 * px);
    }
    for (const corner of corners) {
      const active = selection && selection.kind === 'corner' && selection.id === corner.id;
      const half = (active ? 8 : 6.5) * px;
      ctx.fillStyle = colors.accent; ctx.strokeStyle = colors.ink; ctx.lineWidth = (active ? 2.5 : 1.5) * px;
      ctx.beginPath(); ctx.rect(corner.x - half, corner.y - half, 2 * half, 2 * half); ctx.fill(); ctx.stroke();
    }
  }

  // Draw room: the outline traced so far, plus a dashed line to the pointer.
  if (tracing) {
    ctx.strokeStyle = colors.accent; ctx.lineWidth = 3 * px;
    ctx.beginPath();
    draft.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    if (draft.hover) {
      const lastPoint = draft.points[draft.points.length - 1];
      ctx.setLineDash([6 * px, 4 * px]);
      lines(ctx, lastPoint.x, lastPoint.y, draft.hover.x, draft.hover.y);
      ctx.setLineDash([]);
    }
    draft.points.forEach((p, i) => {
      const radius = (i ? 4 : 7) * px; // the first point is larger: click it to close the room
      ctx.fillStyle = i ? colors.paper : colors.accent; ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.5 * px;
      ellipse(ctx, p.x, p.y, radius, radius); ctx.fill(); ctx.stroke();
    });
  }
  ctx.restore();

  // Dimensions are drawn in screen pixels so the text stays one size at any zoom.
  if (tracing) {
    const points = draft.hover ? draft.points.concat([draft.hover]) : draft.points;
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1], q = points[i], length = distance(p, q);
      if (length * view.scale < 30) continue;
      const middle = toScreen({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
      const angle = Math.atan2(q.y - p.y, q.x - p.x);
      drawLabel(formatLength(length, units), middle.x + Math.sin(angle) * 14, middle.y - Math.cos(angle) * 14, angle,
        i === points.length - 1 && !!draft.hover);
    }
  } else {
    for (const wall of walls) {
      if (wall.length * view.scale < 38) continue;
      const outerFace = toScreen({ x: (wall.a.x + wall.b.x) / 2 - wall.nx * T, y: (wall.a.y + wall.b.y) / 2 - wall.ny * T });
      drawLabel(formatLength(wall.length, units), outerFace.x - wall.nx * 15, outerFace.y - wall.ny * 15,
        Math.atan2(wall.uy, wall.ux), !!selection && selection.kind === 'wall' && selection.id === wall.id);
    }
  }
  if (selection && selection.kind === 'item' && selected) {
    let top = Infinity;
    for (const corner of itemCorners(selected)) top = Math.min(top, corner.y);
    const anchor = toScreen({ x: selected.x, y: top });
    drawLabel(`${formatLength(selected.w, units)} × ${formatLength(selected.d, units)}`, anchor.x, Math.max(14, anchor.y - 15), 0, true);
  }
}
