// The plan data and everything that changes it: undo/redo, selection, tools, the view,
// actions (add, delete, rotate...), browser storage, the saved-designs library, export and import.
//
// The plan format (also the export format, wrapped as { app: 'roomwright', version: 1, plan }):
//   {
//     seq,                    next number for newId()
//     name, units,            units is 'imperial' or 'metric' (display only; all lengths are metres)
//     room: {
//       verts: [{ id, x, y }],            corners, in order; wall i runs from corner i to corner i+1
//       wallHeight, wallColor,
//       wallColors: { cornerId: hex },    per-wall paint, keyed by the wall's starting corner
//       floor: { material, color }
//     },
//     openings: [{ id, type, wall, pos, width, height, sill }],
//                             type: window | door | outlet; wall: starting corner id;
//                             pos: distance from the wall's start to the opening's centre
//     items: [{ id, type, name, x, y, rot, w, d, h, color, material, seat?, side? }]
//                             x, y: centre; rot: degrees; w, d, h: width, depth, height
//                             seat, side: only on sectionals (see itemParts in geometry.js)
//     frames: [{ id, wall, pos, alt, w, h }]
//                             picture frames hung on a wall; wall: starting corner id;
//                             pos: distance from the wall's start to the frame's centre;
//                             alt: height of the frame's centre above the floor; w, h: outside size
//   }

import { INCH, FOOT } from './units.js';
import { polygonArea, pointInPolygon, wallsOf, footprintQuads, rectsOverlap, distance } from './geometry.js';
import {
  ITEM_DEFS, OPENING_DEFAULTS, ROOM_TEMPLATES, MATERIALS, RUG_MATERIALS, FLOOR_MATERIALS,
  isFlat, isSurface, isTuckable, isTabletop,
} from './catalog.js';

const PLAN_KEY = 'roomwright.plan.v1';
const LIBRARY_KEY = 'roomwright.library.v1';

/** Shared, mutable app state. Other modules read it freely and change it through the functions below. */
export const app = {
  plan: null,
  /** { kind: 'item' | 'opening' | 'frame' | 'wall' | 'corner', id } or null. A wall's id is its starting corner's id. */
  selection: null,
  /** 'select' (arrange furniture), 'walls' (edit corners) or 'draw' (trace a new room). */
  tool: 'select',
  /** What the sheet shows: 'plan', 'wall' (the frames wall, face on) or '3d'. */
  sheetView: 'plan',
  /** The wall the Frames tab and the wall view are working on (its starting corner id), or null. */
  frameWall: null,
  /**
   * Settings for suggested frame layouts (Frames tab). gap: space between frames; centre: height of
   * the group's centre; anchor: 'auto', 'wall' (middle of the wall) or the id of a piece to hang
   * over; maxWidth: widest the group should be, or null to work it out.
   */
  frameOptions: { gap: 2 * INCH, centre: 57 * INCH, anchor: 'auto', maxWidth: null },
  /** Pan and zoom of the plan sheet. scale is pixels per metre; width and height are the canvas size in CSS pixels. */
  view: { scale: 60, offsetX: 0, offsetY: 0, width: 1, height: 1 },
  /** Transient drawing aids: the room being traced, the hover point and alignment guides. */
  draft: { points: [], hover: null, guides: [] },
  /** What needs re-rendering on the next animation frame (see main.js). */
  dirty: { draw: true, inspector: true, panels: true },
  undoStack: [],
  redoStack: [],
  /** Saved designs: [{ id, name, saved (timestamp), data (a plan) }]. */
  library: [],
};

export function requestDraw() { app.dirty.draw = true; }
export function requestAll() { app.dirty.draw = app.dirty.inspector = app.dirty.panels = true; }

/* ------------------------------------------------------------------ building plans */

function newId(plan = app.plan) { return 'n' + plan.seq++; }

function makeItem(type, x, y, rot = 0, overrides = {}, plan = app.plan) {
  const def = ITEM_DEFS[type];
  return {
    id: newId(plan), type, name: def.name, x, y, rot,
    w: def.width, d: def.depth, h: def.height, color: def.color, material: def.material,
    ...(def.extra || {}),
    ...overrides,
  };
}

function makeOpening(type, wallId, pos, overrides = {}, plan = app.plan) {
  const { width, height, sill } = OPENING_DEFAULTS[type];
  return { id: newId(plan), type, wall: wallId, pos, width, height, sill, ...overrides };
}

function cornersFromTemplate(key, plan = app.plan) {
  return ROOM_TEMPLATES[key].map(([x, y]) => ({ id: newId(plan), x: x * FOOT, y: y * FOOT }));
}

/** The furnished L-shaped room shown on first load. Positions below are in feet. */
function createSamplePlan() {
  const plan = {
    seq: 1, name: 'Sample living room', units: 'imperial',
    room: { verts: [], wallHeight: 8 * FOOT, wallColor: '#ece9e2', wallColors: {}, floor: { material: 'planks', color: '#c9a577' } },
    openings: [], items: [], frames: [],
  };
  const corners = plan.room.verts = cornersFromTemplate('l', plan);
  plan.room.wallColors[corners[1].id] = '#9aa98f';
  const item = (type, x, y, rot, overrides) => plan.items.push(makeItem(type, x * FOOT, y * FOOT, rot, overrides, plan));
  const opening = (type, wallIndex, pos, overrides) => plan.openings.push(makeOpening(type, corners[wallIndex].id, pos * FOOT, overrides, plan));

  item('rug', 5.5, 5.5, 90); item('media', 0.67, 5.5, 270); item('sofa', 9.5, 5.5, 90);
  item('coffee', 5.6, 5.5, 90); item('armchair', 3.6, 1.9, 15);
  item('flamp', 10.2, 1.1); item('side', 10, 9.9); item('tlamp', 10, 9.9);
  item('round', 14.6, 3.6); item('chair', 14.6, 1.5); item('chair', 14.6, 5.7, 180);
  item('chair', 12.5, 3.6, 270); item('chair', 16.7, 3.6, 90);
  item('bookshelf', 17.5, 8.6, 90); item('plant', 11.9, 10.1);
  item('desk', 4, 14.92, 180); item('office', 4, 13); item('tlamp', 2.4, 15.2);
  item('plant', 10.1, 15.1, 0, { color: '#f1efe9' });

  opening('window', 0, 4.5, { width: 60 * INCH }); opening('window', 0, 14.6);
  opening('window', 5, 3, { width: 36 * INCH }); opening('door', 2, 3.5);
  opening('outlet', 5, 10.5); opening('outlet', 4, 8); opening('outlet', 1, 6.2); opening('outlet', 0, 10.2);
  return plan;
}

/* ------------------------------------------------------------------ storage, undo, redo */

let lastSnapshot = '';

function savePlan() {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(app.plan)); } catch (e) { /* storage unavailable: carry on unsaved */ }
}

/** Load the autosaved plan, or the sample room if there isn't a usable one. Call once at startup. */
export function initPlan() {
  let stored = null;
  try { stored = normalizePlan(JSON.parse(localStorage.getItem(PLAN_KEY))); } catch (e) { /* fall through to the sample */ }
  app.plan = stored || createSamplePlan();
  lastSnapshot = JSON.stringify(app.plan);
}

/**
 * Call after changing the plan. Records an undo step, autosaves and re-renders.
 * Does nothing if the plan is unchanged, so it is safe to call liberally.
 */
export function commit() {
  const snapshot = JSON.stringify(app.plan);
  if (snapshot === lastSnapshot) return;
  app.undoStack.push(lastSnapshot);
  if (app.undoStack.length > 100) app.undoStack.shift();
  app.redoStack.length = 0;
  lastSnapshot = snapshot;
  savePlan();
  requestAll();
}

function restore(snapshot) {
  app.plan = JSON.parse(snapshot);
  lastSnapshot = snapshot;
  if (app.selection && !findSelected()) app.selection = null;
  savePlan();
  requestAll();
}

export function undo() {
  if (!app.undoStack.length) return;
  app.redoStack.push(lastSnapshot);
  restore(app.undoStack.pop());
}

export function redo() {
  if (!app.redoStack.length) return;
  app.undoStack.push(lastSnapshot);
  restore(app.redoStack.pop());
}

/* ------------------------------------------------------------------ queries */

/** The object behind the selection: an item, an opening, or (for walls and corners) the corner. */
export function findSelected(selection = app.selection) {
  if (!selection) return null;
  if (selection.kind === 'item') return app.plan.items.find(item => item.id === selection.id);
  if (selection.kind === 'opening') return app.plan.openings.find(opening => opening.id === selection.id);
  if (selection.kind === 'frame') return app.plan.frames.find(frame => frame.id === selection.id);
  return app.plan.room.verts.find(corner => corner.id === selection.id);
}

export const getWalls = () => wallsOf(app.plan.room.verts);
export const findWall = id => getWalls().find(wall => wall.id === id);
export const wallColor = wallId => app.plan.room.wallColors[wallId] || app.plan.room.wallColor;

/** Items in drawing order: rugs first, tabletop pieces last. */
export function itemsInDrawOrder() {
  const layer = item => (isFlat(ITEM_DEFS[item.type].kind) ? 0 : isTabletop(item.type) ? 2 : 1);
  return app.plan.items.slice().sort((a, b) => layer(a) - layer(b));
}

/**
 * Placement problems, as { itemId: 'outside' | 'overlap' }.
 * Rugs and tabletop pieces never overlap anything; chairs may tuck under tables and desks.
 */
export function findIssues() {
  const issues = {};
  const { items, room } = app.plan;
  // Each item is a list of rectangles: one for most pieces, two for an L-shaped sectional.
  const quads = items.map(item => footprintQuads(item, 0.012));
  items.forEach((item, i) => {
    if (quads[i].some(quad => quad.some(corner => !pointInPolygon(corner, room.verts)))) issues[item.id] = 'outside';
  });
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const kindA = ITEM_DEFS[a.type].kind, kindB = ITEM_DEFS[b.type].kind;
      if (isFlat(kindA) || isFlat(kindB) || isTabletop(a.type) || isTabletop(b.type)) continue;
      if ((isTuckable(kindA) && isSurface(kindB)) || (isTuckable(kindB) && isSurface(kindA))) continue;
      if (quads[i].some(a => quads[j].some(b => rectsOverlap(a, b)))) {
        issues[a.id] = issues[a.id] || 'overlap';
        issues[b.id] = issues[b.id] || 'overlap';
      }
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ view */

export const toWorld = (screenX, screenY) => ({
  x: (screenX - app.view.offsetX) / app.view.scale,
  y: (screenY - app.view.offsetY) / app.view.scale,
});
export const toScreen = point => ({
  x: point.x * app.view.scale + app.view.offsetX,
  y: point.y * app.view.scale + app.view.offsetY,
});

/** Zoom and centre so the whole room fits, leaving space for the toolbar, hint and wall dimensions. */
export function fitView() {
  const view = app.view;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const corner of app.plan.room.verts) {
    minX = Math.min(minX, corner.x); minY = Math.min(minY, corner.y);
    maxX = Math.max(maxX, corner.x); maxY = Math.max(maxY, corner.y);
  }
  const padX = 54, padTop = 80, padBottom = view.width < 520 ? 84 : 62;
  const roomW = maxX - minX || 1, roomH = maxY - minY || 1;
  const availableH = view.height - padTop - padBottom;
  view.scale = Math.max(8, Math.min((view.width - 2 * padX) / roomW, availableH / roomH));
  view.offsetX = (view.width - roomW * view.scale) / 2 - minX * view.scale;
  view.offsetY = padTop + (availableH - roomH * view.scale) / 2 - minY * view.scale;
  requestDraw();
}

/* ------------------------------------------------------------------ selection and tools */

export function setSelection(selection) {
  if (JSON.stringify(selection) === JSON.stringify(app.selection)) return false;
  app.selection = selection;
  app.dirty.inspector = app.dirty.draw = app.dirty.panels = true;
  return true;
}

export function setTool(tool) {
  app.tool = tool;
  app.draft.points = [];
  app.draft.hover = null;
  app.draft.guides = [];
  const kind = app.selection && app.selection.kind;
  if (tool !== 'select' && (kind === 'item' || kind === 'opening')) setSelection(null);
  if (tool !== 'walls' && kind === 'corner') setSelection(null);
  app.dirty.panels = app.dirty.draw = true;
}

/* ------------------------------------------------------------------ keeping things valid */

/**
 * Keep every opening and picture frame on an existing wall and within that wall's length
 * (and frames below the ceiling). Call after the room shape or ceiling height changes.
 */
export function clampOpenings() {
  const walls = getWalls();
  const ceiling = app.plan.room.wallHeight;
  app.plan.openings = app.plan.openings.filter(opening => {
    const wall = walls.find(w => w.id === opening.wall);
    if (!wall) return false;
    opening.width = Math.min(opening.width, Math.max(0.05, wall.length - 0.02));
    opening.pos = Math.max(opening.width / 2, Math.min(wall.length - opening.width / 2, opening.pos));
    return true;
  });
  app.plan.frames = app.plan.frames.filter(frame => {
    const wall = walls.find(w => w.id === frame.wall);
    if (!wall) return false;
    frame.w = Math.min(frame.w, Math.max(0.05, wall.length - 0.02));
    frame.h = Math.min(frame.h, ceiling - 0.02);
    frame.pos = Math.max(frame.w / 2, Math.min(wall.length - frame.w / 2, frame.pos));
    frame.alt = Math.max(frame.h / 2, Math.min(ceiling - frame.h / 2, frame.alt));
    return true;
  });
}

/** Keep a sectional's seat depth sensible for its overall size. Does nothing for other pieces. */
export function fitSectional(item) {
  if (!(item.seat > 0)) return;
  const most = Math.min(item.w, item.d) - 0.1;
  item.seat = most < 0.3 ? Math.min(item.w, item.d) / 2 : Math.max(0.3, Math.min(most, item.seat));
  if (item.side !== 'left') item.side = 'right';
}

/** Snap a dragged item to the measuring grid (1 in or 1 cm), then pull it flush against any wall it is close to. */
export function snapItemToWalls(item) {
  const unit = app.plan.units === 'metric' ? 0.01 : INCH;
  item.x = Math.round(item.x / unit) * unit;
  item.y = Math.round(item.y / unit) * unit;
  if (isTabletop(item.type)) return;
  for (const wall of getWalls()) {
    // Signed distance from the wall to the item's nearest corner (positive = inside the room).
    let gap = Infinity;
    for (const quad of footprintQuads(item)) for (const corner of quad) {
      gap = Math.min(gap, (corner.x - wall.a.x) * wall.nx + (corner.y - wall.a.y) * wall.ny);
    }
    const along = (item.x - wall.a.x) * wall.ux + (item.y - wall.a.y) * wall.uy;
    if (along >= 0 && along <= wall.length && gap > -0.3 && gap < 0.1) {
      item.x -= wall.nx * gap;
      item.y -= wall.ny * gap;
    }
  }
}

/* ------------------------------------------------------------------ actions */

/** Drop a new piece near the middle of the view (or the room, if the view centre is outside it). */
export function addItem(type) {
  const { plan, view } = app;
  const corners = plan.room.verts;
  const viewCentre = toWorld(view.width / 2, view.height / 2);
  let spot = viewCentre;
  if (!pointInPolygon(viewCentre, corners)) {
    spot = { x: 0, y: 0 };
    corners.forEach(c => { spot.x += c.x / corners.length; spot.y += c.y / corners.length; });
  }
  const nudge = (plan.items.length % 6) * 0.12; // so repeated adds don't stack exactly
  const item = makeItem(type, spot.x + nudge, spot.y + nudge);
  // A table lamp added while a table is selected lands on that table.
  const selected = app.selection && app.selection.kind === 'item' && findSelected();
  if (selected && isTabletop(type) && isSurface(ITEM_DEFS[selected.type].kind)) { item.x = selected.x; item.y = selected.y; }
  plan.items.push(item);
  if (app.tool !== 'select') setTool('select');
  app.selection = { kind: 'item', id: item.id };
  commit();
}

/** Add a window, door or outlet to the selected wall, or the longest wall, in the first free spot. */
export function addOpening(type) {
  const walls = getWalls();
  const selection = app.selection;
  let wall = null;
  if (selection && selection.kind === 'wall') wall = walls.find(w => w.id === selection.id);
  if (selection && selection.kind === 'opening') wall = walls.find(w => w.id === (findSelected() || {}).wall);
  if (!wall) wall = walls.slice().sort((a, b) => b.length - a.length)[0];

  const opening = makeOpening(type, wall.id, wall.length / 2);
  opening.width = Math.min(opening.width, wall.length * 0.8);
  opening.height = Math.min(opening.height, app.plan.room.wallHeight - opening.sill);
  const neighbours = app.plan.openings.filter(o => o.wall === wall.id);
  for (const fraction of [0.5, 0.25, 0.75, 0.12, 0.88, 0.38, 0.62]) {
    const pos = wall.length * fraction;
    if (pos - opening.width / 2 < 0 || pos + opening.width / 2 > wall.length) continue;
    if (neighbours.every(o => Math.abs(o.pos - pos) > (o.width + opening.width) / 2 + 0.05)) { opening.pos = pos; break; }
  }
  app.plan.openings.push(opening);
  if (app.tool !== 'select') setTool('select');
  app.selection = { kind: 'opening', id: opening.id };
  clampOpenings();
  commit();
}

/**
 * Hang a picture frame (w × h, in metres) on a wall. It goes to the right of any frames already
 * there (as you face the wall), level with them, or in the middle of the wall at 57 in.
 */
export function addFrame(wallId, w, h) {
  const wall = findWall(wallId);
  if (!wall) return;
  const ceiling = app.plan.room.wallHeight;
  const frame = { id: newId(), wall: wall.id, pos: wall.length / 2, alt: Math.min(57 * INCH, ceiling - h / 2 - 0.02), w, h };
  const others = app.plan.frames.filter(f => f.wall === wall.id);
  if (others.length) {
    const s = wall.inwardSign; // facing the wall, "right" runs along the wall when s = 1
    const edge = s > 0 ? Math.max(...others.map(f => f.pos + f.w / 2)) : Math.min(...others.map(f => f.pos - f.w / 2));
    frame.pos = edge + s * (2 * INCH + w / 2);
    const bottom = Math.min(...others.map(f => f.alt - f.h / 2)), top = Math.max(...others.map(f => f.alt + f.h / 2));
    frame.alt = (bottom + top) / 2;
  }
  app.plan.frames.push(frame);
  app.selection = { kind: 'frame', id: frame.id };
  clampOpenings();
  commit();
}

/** Delete the selected item, opening or corner. Walls can't be deleted directly; remove a corner instead. */
export function deleteSelection() {
  const selection = app.selection;
  const plan = app.plan;
  if (!selection) return;
  if (selection.kind === 'item') {
    plan.items = plan.items.filter(item => item.id !== selection.id);
  } else if (selection.kind === 'opening') {
    plan.openings = plan.openings.filter(opening => opening.id !== selection.id);
  } else if (selection.kind === 'frame') {
    plan.frames = plan.frames.filter(frame => frame.id !== selection.id);
  } else if (selection.kind === 'corner') {
    const corners = plan.room.verts;
    const index = corners.findIndex(c => c.id === selection.id);
    if (corners.length <= 3 || index < 0) return;
    // The two walls meeting here merge into the previous wall, which inherits this wall's openings and frames.
    const previous = corners[(index - 1 + corners.length) % corners.length];
    const previousLength = distance(previous, corners[index]);
    plan.openings.concat(plan.frames).forEach(o => { if (o.wall === selection.id) { o.wall = previous.id; o.pos += previousLength; } });
    if (app.frameWall === selection.id) app.frameWall = previous.id;
    delete plan.room.wallColors[selection.id];
    corners.splice(index, 1);
    clampOpenings();
  } else {
    return;
  }
  app.selection = null;
  commit();
}

export function duplicateSelection() {
  const frame = app.selection && app.selection.kind === 'frame' && findSelected();
  if (frame) { addFrame(frame.wall, frame.w, frame.h); return; }
  const item = app.selection && app.selection.kind === 'item' && findSelected();
  if (!item) return;
  const copy = { ...item, id: newId(), x: item.x + 0.3, y: item.y + 0.3 };
  app.plan.items.push(copy);
  app.selection = { kind: 'item', id: copy.id };
  commit();
}

/** Turn the selected item, or switch the selected frame between portrait and landscape. */
export function rotateSelection(degrees) {
  const frame = app.selection && app.selection.kind === 'frame' && findSelected();
  if (frame) { [frame.w, frame.h] = [frame.h, frame.w]; clampOpenings(); commit(); return; }
  const item = app.selection && app.selection.kind === 'item' && findSelected();
  if (!item) return;
  item.rot = (((item.rot + degrees) % 360) + 360) % 360;
  commit();
}

/** Replace the room outline. Windows, doors, outlets, frames and per-wall paint belong to the old walls, so they go. */
function replaceRoomShape(corners) {
  app.plan.room.verts = corners;
  app.plan.openings = [];
  app.plan.frames = [];
  app.frameWall = null;
  app.plan.room.wallColors = {};
  app.selection = null;
  fitView();
}

export function applyTemplate(key) {
  replaceRoomShape(cornersFromTemplate(key));
  commit();
}

/** Turn the traced points into the room. Returns false if there aren't enough points yet. */
export function finishDrawing() {
  const points = app.draft.points;
  if (points.length < 3 || Math.abs(polygonArea(points)) < 0.2) return false;
  replaceRoomShape(points.map(p => ({ id: newId(), x: p.x, y: p.y })));
  setTool('select');
  commit();
  return true;
}

/** Add a corner on a wall, `along` metres from its start. Does not commit, so a drag can follow. */
export function splitWall(wall, along) {
  const { plan } = app;
  const corner = { id: newId(), x: wall.a.x + wall.ux * along, y: wall.a.y + wall.uy * along };
  plan.openings.concat(plan.frames).forEach(o => { if (o.wall === wall.id && o.pos > along) { o.wall = corner.id; o.pos -= along; } });
  if (plan.room.wallColors[wall.id]) plan.room.wallColors[corner.id] = plan.room.wallColors[wall.id];
  plan.room.verts.splice(wall.index + 1, 0, corner);
  clampOpenings();
  return corner;
}

export function clearItems() {
  app.plan.items = [];
  if (app.selection && app.selection.kind === 'item') app.selection = null;
  commit();
}

/** Swap in a whole plan (from the library, an import, or the sample). Undo brings the old one back. */
export function replacePlan(plan) {
  app.plan = plan;
  app.selection = null;
  clampOpenings();
  setTool('select');
  fitView();
  commit();
}

export function loadSample() {
  const plan = createSamplePlan();
  plan.units = app.plan.units;
  replacePlan(plan);
}

/* ------------------------------------------------------------------ validation */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const isNumber = value => typeof value === 'number' && isFinite(value);

/**
 * Check and clean plan data that came from outside (storage, the library, pasted text, a file).
 * Accepts a bare plan or the export wrapper. Returns a safe plan, or null if it isn't one.
 * Colours are checked because they are written into the page's HTML.
 */
export function normalizePlan(data) {
  try {
    if (data && data.plan && typeof data.plan === 'object') data = data.plan;
    if (!data || !data.room || !Array.isArray(data.room.verts) || data.room.verts.length < 3) return null;

    const cornerIds = new Set();
    const corners = data.room.verts.map(v => ({ id: String(v.id), x: +v.x, y: +v.y }));
    for (const corner of corners) {
      if (!isNumber(corner.x) || !isNumber(corner.y) || cornerIds.has(corner.id)) return null;
      cornerIds.add(corner.id);
    }
    const hexOr = (color, fallback) => (HEX_COLOR.test(color) ? color : fallback);
    const floor = data.room.floor || {};
    const wallColors = {};
    for (const id in data.room.wallColors || {}) {
      if (cornerIds.has(id) && HEX_COLOR.test(data.room.wallColors[id])) wallColors[id] = data.room.wallColors[id];
    }

    const plan = {
      seq: 1,
      name: String(data.name || 'Imported room').slice(0, 60),
      units: data.units === 'metric' ? 'metric' : 'imperial',
      room: {
        verts: corners,
        wallHeight: isNumber(data.room.wallHeight) ? Math.max(1.5, Math.min(8, data.room.wallHeight)) : 8 * FOOT,
        wallColor: hexOr(data.room.wallColor, '#ece9e2'),
        wallColors,
        floor: { material: FLOOR_MATERIALS[floor.material] ? floor.material : 'planks', color: hexOr(floor.color, '#c9a577') },
      },
      openings: [],
      items: [],
      frames: [],
    };

    for (const item of Array.isArray(data.items) ? data.items : []) {
      const def = ITEM_DEFS[item && item.type];
      if (!def || ![item.x, item.y, item.w, item.d, item.h].every(isNumber) || item.w <= 0 || item.d <= 0) continue;
      const materials = isFlat(def.kind) ? RUG_MATERIALS : MATERIALS;
      const clean = {
        id: String(item.id), type: item.type, name: String(item.name || def.name).slice(0, 60),
        x: item.x, y: item.y, rot: isNumber(item.rot) ? ((item.rot % 360) + 360) % 360 : 0,
        w: Math.min(12, item.w), d: Math.min(12, item.d), h: Math.min(12, Math.max(0.005, item.h)),
        color: hexOr(item.color, def.color), material: materials[item.material] ? item.material : def.material,
      };
      if (def.extra && 'seat' in def.extra) {
        clean.seat = isNumber(item.seat) && item.seat > 0 ? item.seat : def.extra.seat;
        clean.side = item.side === 'left' ? 'left' : 'right';
        fitSectional(clean);
      }
      plan.items.push(clean);
    }
    for (const opening of Array.isArray(data.openings) ? data.openings : []) {
      if (!opening || !OPENING_DEFAULTS[opening.type] || !cornerIds.has(String(opening.wall))) continue;
      if (![opening.pos, opening.width, opening.height].every(isNumber) || opening.width <= 0) continue;
      plan.openings.push({
        id: String(opening.id), type: opening.type, wall: String(opening.wall), pos: opening.pos,
        width: opening.width, height: opening.height, sill: isNumber(opening.sill) ? Math.max(0, opening.sill) : 0,
      });
    }
    for (const frame of Array.isArray(data.frames) ? data.frames : []) {
      if (!frame || !cornerIds.has(String(frame.wall))) continue;
      if (![frame.pos, frame.alt, frame.w, frame.h].every(isNumber) || frame.w <= 0 || frame.h <= 0) continue;
      plan.frames.push({
        id: String(frame.id), wall: String(frame.wall), pos: frame.pos, alt: frame.alt,
        w: Math.min(6, frame.w), h: Math.min(6, frame.h),
      });
    }

    // Make ids unique, then start the id counter above every number already in use.
    const seen = new Set(cornerIds);
    let renamed = 0;
    for (const thing of plan.items.concat(plan.openings, plan.frames)) {
      if (seen.has(thing.id)) thing.id = `x${renamed++}_${thing.id}`;
      seen.add(thing.id);
    }
    let highest = 0;
    for (const id of seen) { const match = /(\d+)$/.exec(id); if (match) highest = Math.max(highest, +match[1]); }
    plan.seq = highest + 1;
    return plan;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ saved designs, export, import */

export function loadLibrary() {
  try {
    const stored = JSON.parse(localStorage.getItem(LIBRARY_KEY));
    if (Array.isArray(stored)) app.library = stored.filter(e => e && e.id && e.data && typeof e.name === 'string');
  } catch (e) { /* no library yet */ }
}

function storeLibrary() {
  try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(app.library)); return true; } catch (e) { return false; }
}

/** Save the current plan under its name, replacing a saved design with the same name. */
export function saveToLibrary() {
  const name = app.plan.name;
  const data = JSON.parse(JSON.stringify(app.plan));
  const existing = app.library.find(entry => entry.name === name);
  if (existing) { existing.data = data; existing.saved = Date.now(); }
  else app.library.push({ id: 'd' + Date.now().toString(36) + Math.floor(Math.random() * 1e4), name, saved: Date.now(), data });
  return { name, updated: !!existing, stored: storeLibrary() };
}

/** Open a saved design. Returns its name, or null if it could not be read. */
export function openFromLibrary(id) {
  const entry = app.library.find(e => e.id === id);
  const plan = entry && normalizePlan(JSON.parse(JSON.stringify(entry.data)));
  if (!plan) return null;
  replacePlan(plan);
  return entry.name;
}

export function deleteFromLibrary(id) {
  const entry = app.library.find(e => e.id === id);
  if (!entry) return null;
  app.library = app.library.filter(e => e !== entry);
  storeLibrary();
  return entry.name;
}

export function exportPlanText() {
  return JSON.stringify({ app: 'roomwright', version: 1, plan: app.plan });
}

/** Load a plan from exported text. Returns the plan's name, or null if the text isn't a design. */
export function importPlanText(text) {
  let data = null;
  try { data = JSON.parse(String(text).trim()); } catch (e) { /* not JSON */ }
  const plan = data && normalizePlan(data);
  if (!plan) return null;
  replacePlan(plan);
  return plan.name;
}
