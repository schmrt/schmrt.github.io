// The wall view: one wall seen face on, as you'd stand in the room looking at it, for hanging
// and arranging picture frames. It draws on the plan sheet's canvas (input.js and main.js hand it
// the pointer events and the redraw while the sheet's view is 'wall').
//
// "Face" coordinates: x is metres from the wall's left end as you face it, alt is metres above the
// floor. A wall runs from its start corner to its end corner; facing it from inside the room, that
// direction points right when wall.inwardSign is 1 and left when it is -1.

import { INCH, formatLength } from './units.js';
import { footprintQuads } from './geometry.js';
import { ITEM_DEFS, isFlat, isTabletop } from './catalog.js';
import { artColor, frameBorders } from './frames.js';
import { colors, sheetContext, patternFor, roundedRect, lines } from './draw.js';
import { app, commit, requestDraw, getWalls, wallColor, findSelected, setSelection, clampOpenings } from './state.js';

/** Pieces closer to the wall than this (metres) show up in the wall view and count as "against" it. */
const AGAINST = 0.3;

/* ------------------------------------------------------------------ which wall, and what's on it */

/**
 * The wall the Frames tab and wall view work on: the selected frame's wall, else the selected
 * wall, else the last one used, else the wall with the most frames, else the longest.
 */
export function frameWall() {
  const walls = getWalls();
  const selection = app.selection;
  const selected = findSelected();
  let id = null;
  if (selection && selection.kind === 'frame' && selected) id = selected.wall;
  else if (selection && selection.kind === 'wall') id = selection.id;
  else if (walls.some(w => w.id === app.frameWall)) id = app.frameWall;
  else {
    const count = wall => app.plan.frames.filter(f => f.wall === wall.id).length;
    id = walls.slice().sort((a, b) => count(b) - count(a) || b.length - a.length)[0].id;
  }
  app.frameWall = id;
  return walls.find(w => w.id === id);
}

/** Distance from the wall's left end, as you face it, for a point `along` metres from its start (and back again). */
export const faceX = (wall, along) => (wall.inwardSign > 0 ? along : wall.length - along);

export const framesOn = wall => app.plan.frames.filter(f => f.wall === wall.id);

/**
 * Furniture standing against a wall, as silhouettes in face coordinates:
 * [{ item, left, right, top }]. Rugs and table lamps are left out.
 */
export function piecesAgainst(wall) {
  const pieces = [];
  for (const item of app.plan.items) {
    if (isFlat(ITEM_DEFS[item.type].kind) || isTabletop(item.type)) continue;
    let left = Infinity, right = -Infinity;
    for (const quad of footprintQuads(item)) {
      const inward = quad.map(c => (c.x - wall.a.x) * wall.nx + (c.y - wall.a.y) * wall.ny);
      const along = quad.map(c => (c.x - wall.a.x) * wall.ux + (c.y - wall.a.y) * wall.uy);
      if (Math.min(...inward) > AGAINST || Math.max(...along) <= 0 || Math.min(...along) >= wall.length) continue;
      for (const a of along) { const x = faceX(wall, Math.max(0, Math.min(wall.length, a))); left = Math.min(left, x); right = Math.max(right, x); }
    }
    if (right - left > 0.02) pieces.push({ item, left, right, top: item.h });
  }
  return pieces;
}

/** Windows and doors on a wall, as rectangles in face coordinates: [{ opening, left, right, bottom, top }]. */
function openingsOn(wall) {
  return app.plan.openings.filter(o => o.wall === wall.id).map(o => {
    const x = faceX(wall, o.pos), bottom = o.type === 'door' ? 0 : o.sill;
    return { opening: o, left: x - o.width / 2, right: x + o.width / 2, bottom, top: bottom + o.height };
  });
}

const frameBox = (wall, f) => {
  const x = faceX(wall, f.pos);
  return { left: x - f.w / 2, right: x + f.w / 2, bottom: f.alt - f.h / 2, top: f.alt + f.h / 2 };
};
const boxesOverlap = (a, b, slack = 0.002) =>
  a.left < b.right - slack && b.left < a.right - slack && a.bottom < b.top - slack && b.bottom < a.top - slack;

/**
 * Frames that need a look, as { frameId: 'opening' | 'frame' | 'furniture' }: covering a window
 * or door, overlapping another frame, or hanging down behind a piece of furniture.
 */
export function frameProblems() {
  const problems = {};
  for (const wall of getWalls()) {
    const frames = framesOn(wall);
    if (!frames.length) continue;
    const boxes = frames.map(f => frameBox(wall, f));
    const holes = openingsOn(wall).filter(o => o.opening.type !== 'outlet');
    const pieces = piecesAgainst(wall);
    frames.forEach((f, i) => {
      if (holes.some(h => boxesOverlap(boxes[i], h))) problems[f.id] = 'opening';
      else if (boxes.some((b, j) => j !== i && boxesOverlap(boxes[i], b))) problems[f.id] = 'frame';
      else if (pieces.some(p => boxesOverlap(boxes[i], { left: p.left, right: p.right, bottom: 0, top: p.top }))) problems[f.id] = 'furniture';
    });
  }
  return problems;
}

/* ------------------------------------------------------------------ fitting the wall to the sheet */

function layoutView() {
  const wall = frameWall();
  const { view } = app;
  const height = app.plan.room.wallHeight;
  const padX = 64, padTop = 70, padBottom = 76;
  const scale = Math.max(4, Math.min((view.width - 2 * padX) / wall.length, (view.height - padTop - padBottom) / height));
  const left = (view.width - wall.length * scale) / 2;
  const floor = padTop + (view.height - padTop - padBottom + height * scale) / 2;
  return { wall, height, scale, left, floor };
}

/* ------------------------------------------------------------------ drawing */

/** Draw a frame (moulding, mat and a block of colour for the picture) centred at x, alt. Context is in metres, y down. */
function drawFrame(c, f, x, px) {
  const { moulding, mat } = frameBorders(f.w, f.h);
  const left = x - f.w / 2, top = -(f.alt + f.h / 2);
  c.fillStyle = '#2e2c2b';
  c.fillRect(left, top, f.w, f.h);
  c.fillStyle = '#f6f4ee';
  c.fillRect(left + moulding, top + moulding, f.w - 2 * moulding, f.h - 2 * moulding);
  const inset = moulding + mat;
  if (f.w > 2 * inset && f.h > 2 * inset) {
    c.fillStyle = artColor(f.id);
    c.fillRect(left + inset, top + inset, f.w - 2 * inset, f.h - 2 * inset);
  }
  c.strokeStyle = 'rgba(0,0,0,.35)';
  c.lineWidth = px;
  c.strokeRect(left, top, f.w, f.h);
}

/** A text pill in screen pixels. */
function label(ctx, text, x, y, highlighted = false) {
  ctx.font = '500 11px "IBM Plex Mono",ui-monospace,monospace';
  const width = ctx.measureText(text).width + 10;
  ctx.fillStyle = highlighted ? colors.accent : colors.paper;
  ctx.globalAlpha = highlighted ? 1 : 0.92;
  roundedRect(ctx, x - width / 2, y - 9, width, 18, 4); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = highlighted ? colors['accent-ink'] : colors['ink-2'];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
}

/** Redraw the sheet as the frames wall, face on. */
export function drawWallView() {
  const { ctx, pixelRatio } = sheetContext();
  const { plan, view, selection } = app;
  const units = plan.units;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.fillStyle = colors.paper;
  ctx.fillRect(0, 0, view.width, view.height);

  const { wall, height, scale, left, floor } = layoutView();
  const px = 1 / scale;
  const L = wall.length;
  const frames = framesOn(wall);
  const problems = frameProblems();
  const chosen = selection && selection.kind === 'frame' ? findSelected() : null;

  // Everything in this block is in metres: x from the wall's left end, y = -height above the floor.
  ctx.save();
  ctx.translate(left, floor);
  ctx.scale(scale, scale);

  // Floor, then the wall.
  ctx.fillStyle = plan.room.floor.color;
  ctx.fillRect(-0.3, 0, L + 0.6, 0.1);
  const floorPattern = patternFor(plan.room.floor.material);
  if (floorPattern) { ctx.fillStyle = floorPattern; ctx.fillRect(-0.3, 0, L + 0.6, 0.1); }
  ctx.fillStyle = wallColor(wall.id);
  ctx.fillRect(0, -height, L, height);
  ctx.strokeStyle = colors.ink;
  ctx.lineWidth = 1.5 * px;
  ctx.strokeRect(0, -height, L, height);

  // Windows, doors and outlets.
  for (const hole of openingsOn(wall)) {
    const { opening } = hole, w = hole.right - hole.left, h = hole.top - hole.bottom;
    ctx.lineWidth = 1.2 * px;
    ctx.strokeStyle = colors.ink;
    if (opening.type === 'outlet') {
      ctx.fillStyle = '#f7f6f2';
      ctx.fillRect(hole.left, -hole.top, w, h); ctx.strokeRect(hole.left, -hole.top, w, h);
    } else if (opening.type === 'window') {
      ctx.fillStyle = '#cfe0ec';
      ctx.fillRect(hole.left, -hole.top, w, h); ctx.strokeRect(hole.left, -hole.top, w, h);
      lines(ctx, hole.left + w / 2, -hole.top, hole.left + w / 2, -hole.bottom, hole.left, -(hole.bottom + h / 2), hole.right, -(hole.bottom + h / 2));
    } else {
      ctx.fillStyle = colors.paper;
      ctx.fillRect(hole.left, -hole.top, w, h); ctx.strokeRect(hole.left, -hole.top, w, h);
      ctx.beginPath(); ctx.arc(hole.right - 0.07, -0.95, Math.max(0.018, 2.5 * px), 0, Math.PI * 2); ctx.stroke();
    }
  }

  // Furniture against the wall, as silhouettes.
  const pieces = piecesAgainst(wall);
  for (const piece of pieces) {
    const w = piece.right - piece.left;
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = piece.item.color;
    roundedRect(ctx, piece.left, -piece.top, w, piece.top, 0.03); ctx.fill();
    const pattern = patternFor(piece.item.material);
    if (pattern) { ctx.fillStyle = pattern; ctx.fill(); }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.ink; ctx.lineWidth = 1.2 * px; ctx.stroke();
  }

  // The frames, then a dashed outline round the group.
  for (const f of frames) {
    const x = faceX(wall, f.pos);
    drawFrame(ctx, f, x, px);
    if (problems[f.id]) {
      ctx.strokeStyle = colors.warn; ctx.lineWidth = 2.2 * px; ctx.setLineDash([6 * px, 4 * px]);
      ctx.strokeRect(x - f.w / 2 - 3 * px, -(f.alt + f.h / 2) - 3 * px, f.w + 6 * px, f.h + 6 * px);
      ctx.setLineDash([]);
    }
  }
  let group = null;
  if (frames.length > 1) {
    const boxes = frames.map(f => frameBox(wall, f));
    group = {
      left: Math.min(...boxes.map(b => b.left)), right: Math.max(...boxes.map(b => b.right)),
      bottom: Math.min(...boxes.map(b => b.bottom)), top: Math.max(...boxes.map(b => b.top)),
    };
    ctx.strokeStyle = colors['ink-2']; ctx.lineWidth = px; ctx.setLineDash([4 * px, 4 * px]);
    const pad = 8 * px;
    ctx.strokeRect(group.left - pad, -group.top - pad, group.right - group.left + 2 * pad, group.top - group.bottom + 2 * pad);
    ctx.setLineDash([]);
  }
  if (chosen && chosen.wall === wall.id) {
    const x = faceX(wall, chosen.pos), pad = 3 * px;
    ctx.lineWidth = 4 * px; ctx.strokeStyle = colors.ink;
    ctx.strokeRect(x - chosen.w / 2 - pad, -(chosen.alt + chosen.h / 2) - pad, chosen.w + 2 * pad, chosen.h + 2 * pad);
    ctx.lineWidth = 2 * px; ctx.strokeStyle = colors.accent;
    ctx.strokeRect(x - chosen.w / 2 - pad, -(chosen.alt + chosen.h / 2) - pad, chosen.w + 2 * pad, chosen.h + 2 * pad);
    // A dimension line from the floor up to the frame's centre.
    ctx.strokeStyle = colors.accent; ctx.lineWidth = 1.2 * px; ctx.setLineDash([5 * px, 4 * px]);
    lines(ctx, x, 0, x, -(chosen.alt - chosen.h / 2));
    ctx.setLineDash([]);
  }

  // Alignment guides while dragging.
  ctx.strokeStyle = colors.accent; ctx.lineWidth = px; ctx.setLineDash([5 * px, 4 * px]);
  for (const guide of app.draft.guides) {
    if (guide.faceX != null) lines(ctx, guide.faceX, 0, guide.faceX, -height);
    if (guide.alt != null) lines(ctx, 0, -guide.alt, L, -guide.alt);
  }
  ctx.setLineDash([]);
  ctx.restore();

  // Labels, in screen pixels.
  const sx = x => left + x * scale, sy = alt => floor - alt * scale;
  label(ctx, formatLength(L, units), sx(L / 2), sy(0) + 26);
  ctx.save();
  ctx.translate(sx(0) - 22, sy(height / 2));
  ctx.rotate(-Math.PI / 2);
  label(ctx, formatLength(height, units), 0, 0);
  ctx.restore();
  for (const piece of pieces) {
    if ((piece.right - piece.left) * scale > 60 && piece.top * scale > 22) {
      ctx.font = '500 12px "Barlow Semi Condensed",system-ui,sans-serif';
      ctx.fillStyle = colors.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(piece.item.name, sx((piece.left + piece.right) / 2), sy(piece.top / 2));
    }
  }
  if (group && !(chosen && chosen.wall === wall.id)) {
    const centre = (group.top + group.bottom) / 2;
    label(ctx, `Group ${formatLength(group.right - group.left, units)} × ${formatLength(group.top - group.bottom, units)} · centre ${formatLength(centre, units)} up`,
      sx((group.left + group.right) / 2), Math.max(14, sy(group.top) - 22));
  }
  if (chosen && chosen.wall === wall.id) {
    const x = faceX(wall, chosen.pos);
    label(ctx, `${formatLength(chosen.w, units)} × ${formatLength(chosen.h, units)}`, sx(x), Math.max(14, sy(chosen.alt + chosen.h / 2) - 18), true);
    label(ctx, `centre ${formatLength(chosen.alt, units)} up`, sx(x), sy((chosen.alt - chosen.h / 2) / 2));
  }
  if (!frames.length) {
    label(ctx, 'No frames on this wall yet', sx(L / 2), sy(height * 0.6));
  }
}

/* ------------------------------------------------------------------ pointer and keyboard */

let drag = null;

const toFace = (v, screen) => ({ x: (screen.x - v.left) / v.scale, alt: (v.floor - screen.y) / v.scale });

function frameAt(v, point) {
  const pad = 3 / v.scale;
  const frames = framesOn(v.wall);
  for (let i = frames.length - 1; i >= 0; i--) {
    const b = frameBox(v.wall, frames[i]);
    if (point.x >= b.left - pad && point.x <= b.right + pad && point.alt >= b.bottom - pad && point.alt <= b.top + pad) return frames[i];
  }
  return null;
}

/** Snap a dragged frame's centre (face coordinates) to the grid, other frames' edges and gaps, and the centres of the wall and furniture. */
function snapFrame(v, frame, x, alt, free) {
  const guides = app.draft.guides = [];
  if (free) return { x, alt };
  const unit = app.plan.units === 'metric' ? 0.01 : INCH / 2;
  x = Math.round(x / unit) * unit;
  alt = Math.round(alt / unit) * unit;
  const tolerance = 7 / v.scale, gap = app.frameOptions.gap;
  const targetsX = [v.wall.length / 2], targetsAlt = [];
  for (const p of piecesAgainst(v.wall)) targetsX.push((p.left + p.right) / 2);
  for (const other of framesOn(v.wall)) {
    if (other.id === frame.id) continue;
    const b = frameBox(v.wall, other);
    targetsX.push(b.left, (b.left + b.right) / 2, b.right, b.right + gap, b.left - gap);
    targetsAlt.push(b.bottom, other.alt, b.top, b.top + gap, b.bottom - gap);
  }
  // Each candidate is an offset from the frame's centre: its left edge, centre and right edge (and the same up and down).
  const best = (value, half, targets) => {
    let pick = null;
    for (const offset of [-half, 0, half]) {
      for (const target of targets) {
        const diff = target - (value + offset);
        if (Math.abs(diff) < tolerance && (!pick || Math.abs(diff) < Math.abs(pick.diff))) pick = { diff, line: target };
      }
    }
    return pick;
  };
  const snapX = best(x, frame.w / 2, targetsX), snapAlt = best(alt, frame.h / 2, targetsAlt);
  if (snapX) { x += snapX.diff; guides.push({ faceX: snapX.line }); }
  if (snapAlt) { alt += snapAlt.diff; guides.push({ alt: snapAlt.line }); }
  return { x, alt };
}

/** Put a frame's centre at a face position, kept on the wall. */
function placeFrame(v, frame, x, alt) {
  x = Math.max(frame.w / 2, Math.min(v.wall.length - frame.w / 2, x));
  frame.pos = faceX(v.wall, x); // faceX is its own inverse
  frame.alt = alt;
  clampOpenings();
}

export function wallPointerDown(event, screen) {
  const v = layoutView();
  const point = toFace(v, screen);
  const frame = frameAt(v, point);
  if (frame) {
    setSelection({ kind: 'frame', id: frame.id });
    drag = { id: frame.id, grabX: faceX(v.wall, frame.pos) - point.x, grabAlt: frame.alt - point.alt, start: screen };
  } else {
    drag = { id: null, start: screen };
  }
}

export function wallPointerMove(event, screen) {
  if (!drag) return;
  if (!drag.moved && Math.hypot(screen.x - drag.start.x, screen.y - drag.start.y) < 4) return;
  drag.moved = true;
  if (!drag.id) return;
  const v = layoutView();
  const frame = app.plan.frames.find(f => f.id === drag.id);
  if (!frame) return;
  const point = toFace(v, screen);
  const snapped = snapFrame(v, frame, point.x + drag.grabX, point.alt + drag.grabAlt, event.altKey);
  placeFrame(v, frame, snapped.x, snapped.alt);
  drag.changed = true;
  requestDraw();
}

export function wallPointerUp() {
  if (!drag) return;
  const finished = drag;
  drag = null;
  app.draft.guides = [];
  requestDraw();
  if (finished.changed) commit();
  else if (!finished.moved && !finished.id) setSelection(null);
}

/** Arrow keys move the selected frame: left and right as you face the wall, up and down the wall. */
export function nudgeFrame(key, big) {
  const frame = findSelected();
  if (!frame) return;
  const v = layoutView();
  const step = (app.plan.units === 'metric' ? 0.01 : INCH / 2) * (big ? 10 : 1);
  const x = faceX(v.wall, frame.pos) + (key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0);
  const alt = frame.alt + (key === 'arrowup' ? step : key === 'arrowdown' ? -step : 0);
  placeFrame(v, frame, x, alt);
  commit();
}
