// Picture-frame layouts. Pure functions, no app state: given a list of frame sizes, suggest
// several ways to hang them as a group, best first.
//
// Frames come in as [{ id, w, h }] (metres). A layout is { name, spots: [{ id, x, y }], width, height }
// where x, y are each frame's centre relative to the centre of the group, x to the right and
// y UP (as you face the wall). width and height are the size of the whole group.

/** Seeded random numbers (mulberry32), so "shuffled" layouts are the same every time for the same frames. */
function seededRandom(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Move the spots so the group's bounding box is centred on (0, 0), and record its size. */
function centred(name, frames, spots) {
  const byId = new Map(frames.map(f => [f.id, f]));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const spot of spots) {
    const f = byId.get(spot.id);
    minX = Math.min(minX, spot.x - f.w / 2); maxX = Math.max(maxX, spot.x + f.w / 2);
    minY = Math.min(minY, spot.y - f.h / 2); maxY = Math.max(maxY, spot.y + f.h / 2);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return { name, spots: spots.map(s => ({ id: s.id, x: s.x - cx, y: s.y - cy })), width: maxX - minX, height: maxY - minY };
}

/**
 * Lay frames side by side in one line. `align` lines them up on their centres, tops or bottoms.
 * Returns spots for a row starting at x = 0 with its centre line at y = 0, plus the row's width.
 */
function lineUp(frames, gap, align = 'middle') {
  const tallest = Math.max(...frames.map(f => f.h));
  let x = 0;
  const spots = frames.map(f => {
    const y = align === 'top' ? tallest / 2 - f.h / 2 : align === 'bottom' ? -tallest / 2 + f.h / 2 : 0;
    const spot = { id: f.id, x: x + f.w / 2, y };
    x += f.w + gap;
    return spot;
  });
  return { spots, width: x - gap, height: tallest };
}

/** Stack rows of frames (each row a list) with `gap` between them, every row centred. */
function stackRows(rows, gap, align = 'middle') {
  const lined = rows.filter(r => r.length).map(r => lineUp(r, gap, align));
  const total = lined.reduce((sum, r) => sum + r.height, 0) + gap * (lined.length - 1);
  let top = total / 2;
  const spots = [];
  for (const row of lined) {
    const middle = top - row.height / 2;
    for (const s of row.spots) spots.push({ id: s.id, x: s.x - row.width / 2, y: s.y + middle });
    top -= row.height + gap;
  }
  return spots;
}

/** Greedily fill rows up to `maxWidth`, in the order given. */
function fillRows(frames, gap, maxWidth) {
  const rows = [[]];
  let width = 0;
  for (const f of frames) {
    const row = rows[rows.length - 1];
    const needed = row.length ? width + gap + f.w : f.w;
    if (row.length && needed > maxWidth) { rows.push([f]); width = f.w; }
    else { row.push(f); width = needed; }
  }
  return rows;
}

/** Split frames into two rows of about equal width, largest first. */
function splitInTwo(frames) {
  const rows = [[], []], widths = [0, 0];
  for (const f of frames.slice().sort((a, b) => b.w * b.h - a.w * a.h)) {
    const i = widths[0] <= widths[1] ? 0 : 1;
    rows[i].push(f);
    widths[i] += f.w;
  }
  // Put the larger frames in the middle of each row, which reads as more balanced.
  return rows.map(row => {
    const middleOut = [];
    row.forEach((f, i) => (i % 2 ? middleOut.push(f) : middleOut.unshift(f)));
    return middleOut;
  });
}

/* ------------------------------------------------------------------ the layouts */

const GENERATORS = [
  // One straight line, centres level.
  (frames, { gap }) => centred('Row', frames, lineUp(frames, gap).spots),
  // One line with the tops level (looks tidy over a sofa or console).
  (frames, { gap }) => frames.length > 1 && new Set(frames.map(f => f.h)).size > 1 &&
    centred('Row, tops level', frames, lineUp(frames, gap, 'top').spots),
  // One line with the bottoms level (a shelf-like line).
  (frames, { gap }) => frames.length > 1 && new Set(frames.map(f => f.h)).size > 1 &&
    centred('Row, bottoms level', frames, lineUp(frames, gap, 'bottom').spots),
  // A vertical stack, for narrow spaces.
  (frames, { gap }) => frames.length > 1 && frames.length <= 4 &&
    centred('Column', frames, stackRows(frames.map(f => [f]), gap)),
  // Two rows meeting at a shared centre line: top row sits on the line, bottom row hangs from it.
  (frames, { gap }) => {
    if (frames.length < 3) return null;
    const [upper, lower] = splitInTwo(frames);
    const top = lineUp(upper, gap, 'bottom'), bottom = lineUp(lower, gap, 'top');
    const spots = [
      ...top.spots.map(s => ({ id: s.id, x: s.x - top.width / 2, y: s.y + gap / 2 + top.height / 2 })),
      ...bottom.spots.map(s => ({ id: s.id, x: s.x - bottom.width / 2, y: s.y - gap / 2 - bottom.height / 2 })),
    ];
    return centred('Two rows on a centre line', frames, spots);
  },
  // Grids, in each column count that makes sense. Every cell is the size of the largest frame.
  ...[2, 3, 4].map(cols => (frames, { gap }) => {
    if (frames.length < cols + 1 || frames.length > cols * 4) return null;
    const cellW = Math.max(...frames.map(f => f.w)), cellH = Math.max(...frames.map(f => f.h));
    const rows = Math.ceil(frames.length / cols);
    const spots = frames.map((f, i) => {
      const row = Math.floor(i / cols), inRow = Math.min(cols, frames.length - row * cols);
      const col = i % cols;
      return { id: f.id, x: (col - (inRow - 1) / 2) * (cellW + gap), y: ((rows - 1) / 2 - row) * (cellH + gap) };
    });
    return centred(`Grid, ${cols} across`, frames, spots);
  }),
  // The largest frame in the middle with the rest stacked in columns either side.
  (frames, { gap }) => {
    if (frames.length < 3) return null;
    const sorted = frames.slice().sort((a, b) => b.w * b.h - a.w * a.h);
    const [centre, ...rest] = sorted;
    const sides = [[], []], heights = [0, 0];
    for (const f of rest) { const i = heights[0] <= heights[1] ? 0 : 1; sides[i].push(f); heights[i] += f.h + gap; }
    const spots = [{ id: centre.id, x: 0, y: 0 }];
    sides.forEach((column, i) => {
      if (!column.length) return;
      const colW = Math.max(...column.map(f => f.w));
      const x = (i ? 1 : -1) * (centre.w / 2 + gap + colW / 2);
      for (const s of stackRows(column.map(f => [f]), gap)) spots.push({ id: s.id, x, y: s.y });
    });
    return centred('Feature in the middle', frames, spots);
  },
  // Rows packed to the target width, tallest first.
  (frames, { gap, maxWidth }) => frames.length > 2 &&
    centred('Packed rows', frames, stackRows(fillRows(frames.slice().sort((a, b) => b.h - a.h), gap, maxWidth), gap)),
  // Salon style: a few shuffled packings; the scoring keeps the best of them.
  ...[1, 2, 3, 4].map(seed => (frames, { gap, maxWidth }) => {
    if (frames.length < 4) return null;
    const random = seededRandom(seed * 7919 + frames.length);
    const order = frames.slice().sort(() => random() - 0.5);
    const rows = fillRows(order, gap, maxWidth * (0.8 + random() * 0.3));
    return centred('Salon', frames, stackRows(rows, gap, ['middle', 'top', 'bottom'][seed % 3]));
  }),
];

/**
 * How good a layout is, higher is better. Rewards a compact group (little empty space inside its
 * outline) and a gently landscape shape; penalises going wider than `maxWidth` or taller than `maxHeight`.
 */
function score(layout, frames, { maxWidth, maxHeight }) {
  const area = frames.reduce((sum, f) => sum + f.w * f.h, 0);
  const fill = area / (layout.width * layout.height);
  const shape = Math.abs(Math.log(layout.width / layout.height / 1.6)) * 0.25;
  const tooWide = Math.max(0, layout.width - maxWidth) / maxWidth;
  const tooTall = Math.max(0, layout.height - maxHeight) / maxHeight;
  return fill - shape - 3 * tooWide - 3 * tooTall;
}

/**
 * Suggest up to `count` layouts for these frames, best first.
 * options: { gap, maxWidth, maxHeight } in metres.
 */
export function suggestLayouts(frames, options, count = 6) {
  if (!frames.length) return [];
  const seen = new Set();
  const results = [];
  for (const generate of GENERATORS) {
    const layout = generate(frames, options);
    if (!layout) continue;
    // Skip layouts that put every frame in the same place as one already found.
    const key = layout.spots.map(s => `${s.id}:${Math.round(s.x * 100)},${Math.round(s.y * 100)}`).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ ...layout, score: score(layout, frames, options) });
  }
  results.sort((a, b) => b.score - a.score);
  // Several salon packings can win; keep at most two so the choices stay varied.
  let salons = 0;
  return results.filter(l => l.name !== 'Salon' || ++salons <= 2).slice(0, count);
}

/** A muted stand-in colour for the "art" inside a frame, the same every time for the same frame. */
const ART_COLORS = ['#9aa98f', '#b9cfdf', '#dccfb9', '#c98d9a', '#6f8f86', '#d2a43c', '#5f7896', '#b8694d', '#e3c1b4', '#7d8c6a'];
export function artColor(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return ART_COLORS[Math.abs(hash) % ART_COLORS.length];
}

/** Moulding and mat widths for a frame of this size, in metres, so small frames don't vanish into their borders. */
export function frameBorders(w, h) {
  const small = Math.min(w, h);
  return { moulding: Math.min(0.035, small * 0.08), mat: Math.min(0.06, small * 0.12) };
}
