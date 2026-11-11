// Mouse, touch and keyboard handling for the plan sheet.

import { INCH } from './units.js';
import { WALL_THICKNESS as T, distance, distanceToSegment, pointInItem } from './geometry.js';
import {
  app, commit, undo, redo, requestDraw, toWorld, getWalls, findSelected, itemsInDrawOrder,
  setSelection, setTool, clampOpenings, snapItemToWalls, splitWall, finishDrawing,
  deleteSelection, duplicateSelection, rotateSelection,
} from './state.js';
import { setTab } from './panels.js';

let canvas;
/** Active pointers by id, as canvas positions. Two pointers means a pinch. */
const pointers = new Map();
/**
 * The gesture in progress, or null. `type` is one of:
 *   pan, item (move furniture), rotate, opening (slide along walls), corner, pinch.
 * `moved` turns true once the pointer travels far enough to count as a drag rather than a click.
 * `changed` means the plan was edited and needs committing when the gesture ends.
 */
let gesture = null;

const pixels = count => count / app.view.scale; // screen pixels -> metres
const canvasPoint = event => {
  const box = canvas.getBoundingClientRect();
  return { x: event.clientX - box.left, y: event.clientY - box.top };
};

/** Select something by clicking the plan. On a phone, also bring its inspector into view. */
function selectFromCanvas(selection) {
  if (setSelection(selection) && selection && window.innerWidth <= 880) setTab('selected');
}

/* ------------------------------------------------------------------ hit testing */

function itemAt(point) {
  const items = itemsInDrawOrder();
  for (let i = items.length - 1; i >= 0; i--) if (pointInItem(point, items[i], pixels(3))) return items[i];
  return null;
}

function openingAt(point) {
  const walls = getWalls();
  const tolerance = pixels(9);
  for (const opening of app.plan.openings) {
    const wall = walls.find(w => w.id === opening.wall);
    if (!wall) continue;
    const along = (point.x - wall.a.x) * wall.ux + (point.y - wall.a.y) * wall.uy;
    const inward = (point.x - wall.a.x) * wall.nx + (point.y - wall.a.y) * wall.ny;
    // Outlets are drawn just inside the room, so they get a deeper target on that side.
    const reach = opening.type === 'outlet' ? Math.max(0.16, pixels(14)) : tolerance;
    if (Math.abs(along - opening.pos) <= Math.max(opening.width / 2, tolerance) && inward >= -T - tolerance && inward <= reach) return opening;
  }
  return null;
}

/** The wall nearest a point, with `along` (metres from its start). `maxDistance` limits how far away counts. */
function nearestWall(point, maxDistance = Infinity) {
  let best = null;
  for (const wall of getWalls()) {
    const hit = distanceToSegment(point, wall.a, wall.b);
    if (hit.distance < maxDistance) { maxDistance = hit.distance; best = wall; best.along = hit.t * wall.length; }
  }
  return best;
}
const wallAt = point => nearestWall(point, T + pixels(6));

/** Where the selected item's rotate handle is. Must match the handle drawn in draw.js. */
function rotateHandlePosition(item) {
  const angle = (item.rot * Math.PI) / 180;
  const reach = item.d / 2 + pixels(24);
  return { x: item.x - Math.sin(angle) * reach, y: item.y + Math.cos(angle) * reach };
}

/* ------------------------------------------------------------------ snapping */

/** Corners snap to 3 in (or 5 cm). */
const cornerGrid = () => (app.plan.units === 'metric' ? 0.05 : 3 * INCH);

/** Snap a corner to the grid, then line it up with other corners nearby in x or y (showing guides). */
function snapCorner(point, skipId, otherCorners) {
  const grid = cornerGrid(), tolerance = pixels(7);
  let x = Math.round(point.x / grid) * grid;
  let y = Math.round(point.y / grid) * grid;
  const guides = app.draft.guides = [];
  for (const corner of otherCorners) {
    if (corner.id === skipId) continue;
    if (Math.abs(point.x - corner.x) < tolerance) { x = corner.x; guides.push({ x }); }
    if (Math.abs(point.y - corner.y) < tolerance) { y = corner.y; guides.push({ y }); }
  }
  return { x, y };
}

/** Snap the next point of a room being traced: as snapCorner, plus 15° angle steps from the previous point. */
function snapTracePoint(point) {
  const points = app.draft.points;
  if (!points.length) return snapCorner(point, null, app.plan.room.verts);
  const previous = points[points.length - 1];
  const grid = cornerGrid();
  let snapped = snapCorner(point, null, points);
  const angle = Math.atan2(point.y - previous.y, point.x - previous.x);
  const step = Math.PI / 12;
  const nearestStep = Math.round(angle / step) * step;
  if (Math.abs(angle - nearestStep) < 0.08) {
    const length = Math.max(grid, Math.round(distance(point, previous) / grid) * grid);
    const vertical = Math.abs(Math.cos(nearestStep)) < 1e-6;
    const horizontal = Math.abs(Math.sin(nearestStep)) < 1e-6;
    const alignedY = snapped.y !== Math.round(point.y / grid) * grid; // snapCorner lined y up with a corner
    const alignedX = snapped.x !== Math.round(point.x / grid) * grid;
    if (vertical) snapped = { x: previous.x, y: alignedY ? snapped.y : previous.y + Math.sin(nearestStep) * length };
    else if (horizontal) snapped = { x: alignedX ? snapped.x : previous.x + Math.cos(nearestStep) * length, y: previous.y };
    else { snapped = { x: previous.x + Math.cos(nearestStep) * length, y: previous.y + Math.sin(nearestStep) * length }; app.draft.guides = []; }
  }
  return snapped;
}

/* ------------------------------------------------------------------ pointer events */

function onPointerDown(event) {
  canvas.setPointerCapture(event.pointerId);
  const screen = canvasPoint(event);
  pointers.set(event.pointerId, screen);

  if (pointers.size === 2) { // second finger down: switch to pinch zoom
    const [a, b] = [...pointers.values()];
    if (gesture && gesture.changed) commit();
    gesture = {
      type: 'pinch', startDistance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      startMiddle: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, startView: { ...app.view },
    };
    return;
  }
  if (pointers.size > 2) return;

  const point = toWorld(screen.x, screen.y);
  // Default gesture: pan the paper. A click that never moves deselects (unless keepSelection is set).
  const pan = { type: 'pan', start: screen, startOffsetX: app.view.offsetX, startOffsetY: app.view.offsetY };
  gesture = pan;
  if (event.button === 1 || event.button === 2) return; // middle or right button always pans

  if (app.tool === 'select') {
    const current = app.selection && app.selection.kind === 'item' && findSelected();
    if (current && distance(point, rotateHandlePosition(current)) < pixels(11)) {
      gesture = { type: 'rotate', id: current.id, start: screen };
      return;
    }
    const opening = openingAt(point);
    if (opening) {
      selectFromCanvas({ kind: 'opening', id: opening.id });
      gesture = { type: 'opening', id: opening.id, start: screen };
      return;
    }
    const item = itemAt(point);
    if (item) {
      selectFromCanvas({ kind: 'item', id: item.id });
      gesture = { type: 'item', id: item.id, grabX: item.x - point.x, grabY: item.y - point.y, start: screen };
      return;
    }
    const wall = wallAt(point);
    if (wall) { selectFromCanvas({ kind: 'wall', id: wall.id }); pan.keepSelection = true; }
  } else if (app.tool === 'walls') {
    const reach = pixels(11);
    const corner = app.plan.room.verts.find(c => distance(c, point) < reach);
    if (corner) {
      selectFromCanvas({ kind: 'corner', id: corner.id });
      gesture = { type: 'corner', id: corner.id, start: screen };
      return;
    }
    for (const wall of getWalls()) { // the "+" handle in the middle of a wall adds a corner there
      const middle = { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 };
      if (wall.length * app.view.scale > 44 && distance(point, middle) < reach) {
        const added = splitWall(wall, wall.length / 2);
        selectFromCanvas({ kind: 'corner', id: added.id });
        gesture = { type: 'corner', id: added.id, start: screen, changed: true };
        requestDraw();
        return;
      }
    }
    const wall = wallAt(point);
    if (wall) { selectFromCanvas({ kind: 'wall', id: wall.id }); pan.keepSelection = true; }
  }
  // The draw tool places points on click (see onPointerUp); dragging pans.
}

function onPointerMove(event) {
  const screen = canvasPoint(event);
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, screen);
  const point = toWorld(screen.x, screen.y);
  const { view, plan } = app;

  if (!gesture) {
    if (app.tool === 'draw') { app.draft.hover = snapTracePoint(point); requestDraw(); }
    return;
  }
  if (gesture.type === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const spread = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const start = gesture.startView;
    view.scale = Math.max(8, Math.min(400, (start.scale * spread) / gesture.startDistance));
    // Keep the plan point that was under the fingers under them.
    view.offsetX = middle.x - ((gesture.startMiddle.x - start.offsetX) / start.scale) * view.scale;
    view.offsetY = middle.y - ((gesture.startMiddle.y - start.offsetY) / start.scale) * view.scale;
    requestDraw();
    return;
  }
  if (!gesture.moved && Math.hypot(screen.x - gesture.start.x, screen.y - gesture.start.y) < 4) return;
  gesture.moved = true;
  requestDraw();

  if (gesture.type === 'pan') {
    view.offsetX = gesture.startOffsetX + screen.x - gesture.start.x;
    view.offsetY = gesture.startOffsetY + screen.y - gesture.start.y;
    if (app.tool === 'draw') app.draft.hover = null;
  } else if (gesture.type === 'item') {
    const item = plan.items.find(i => i.id === gesture.id);
    if (!item) return;
    item.x = point.x + gesture.grabX;
    item.y = point.y + gesture.grabY;
    if (!event.altKey) snapItemToWalls(item);
    gesture.changed = true;
  } else if (gesture.type === 'rotate') {
    const item = plan.items.find(i => i.id === gesture.id);
    if (!item) return;
    // Point the item's front (+y) at the pointer, in 15° steps unless Alt is held.
    let degrees = (Math.atan2(-(point.x - item.x), point.y - item.y) * 180) / Math.PI;
    if (!event.altKey) degrees = Math.round(degrees / 15) * 15;
    item.rot = ((Math.round(degrees) % 360) + 360) % 360;
    gesture.changed = true;
  } else if (gesture.type === 'opening') {
    const opening = plan.openings.find(o => o.id === gesture.id);
    const wall = nearestWall(point);
    if (!opening || !wall) return;
    const unit = plan.units === 'metric' ? 0.01 : INCH;
    opening.wall = wall.id;
    opening.width = Math.min(opening.width, wall.length - 0.02);
    opening.pos = Math.max(opening.width / 2, Math.min(wall.length - opening.width / 2, Math.round(wall.along / unit) * unit));
    gesture.changed = true;
  } else if (gesture.type === 'corner') {
    const corner = plan.room.verts.find(c => c.id === gesture.id);
    if (!corner) return;
    const snapped = snapCorner(point, corner.id, plan.room.verts);
    corner.x = snapped.x;
    corner.y = snapped.y;
    clampOpenings();
    gesture.changed = true;
  }
}

function onPointerUp(event) {
  const screen = canvasPoint(event);
  pointers.delete(event.pointerId);
  if (!gesture) return;
  const finished = gesture;
  if (finished.type === 'pinch') { if (pointers.size < 2) gesture = null; return; }
  gesture = null;
  app.draft.guides = [];
  requestDraw();
  if (finished.changed) { commit(); return; }

  const clicked = finished.type === 'pan' && !finished.moved && event.type === 'pointerup';
  if (!clicked) return;
  if (app.tool === 'draw') {
    const points = app.draft.points;
    const point = toWorld(screen.x, screen.y);
    if (points.length >= 3 && distance(point, points[0]) < pixels(13)) { finishDrawing(); return; }
    const snapped = snapTracePoint(point);
    const previous = points[points.length - 1];
    if (!previous || distance(previous, snapped) > 0.05) points.push(snapped);
    app.draft.guides = [];
    app.dirty.panels = true; // the hint changes once there are three points
  } else if (!finished.keepSelection) {
    setSelection(null);
  }
}

function onWheel(event) {
  event.preventDefault();
  const { view } = app;
  const screen = canvasPoint(event);
  const anchor = toWorld(screen.x, screen.y);
  // ctrlKey is set for trackpad pinch gestures, which report much smaller deltas.
  const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0016));
  view.scale = Math.max(8, Math.min(400, view.scale * factor));
  view.offsetX = screen.x - anchor.x * view.scale;
  view.offsetY = screen.y - anchor.y * view.scale;
  requestDraw();
}

/* ------------------------------------------------------------------ keyboard */

function onKeyDown(event) {
  const target = event.target;
  const typing = target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
  const modifier = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (modifier && key === 'z') { if (typing) return; event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if (modifier && key === 'y') { if (typing) return; event.preventDefault(); redo(); return; }
  if (typing) return;

  if (key === 'escape') { if (app.tool === 'draw') setTool('select'); else setSelection(null); return; }
  if (key === 'enter' && app.tool === 'draw') { finishDrawing(); return; }
  if (key === 'delete' || key === 'backspace') { event.preventDefault(); deleteSelection(); return; }
  if (modifier && key === 'd') { event.preventDefault(); duplicateSelection(); return; }
  if (key === 'r' && !modifier) { rotateSelection(event.shiftKey ? 15 : 90); return; }

  if (key.startsWith('arrow') && app.selection && app.selection.kind === 'item') {
    const item = findSelected();
    if (!item) return;
    event.preventDefault();
    const step = (app.plan.units === 'metric' ? 0.01 : INCH) * (event.shiftKey ? 10 : 1);
    if (key === 'arrowleft') item.x -= step;
    if (key === 'arrowright') item.x += step;
    if (key === 'arrowup') item.y -= step;
    if (key === 'arrowdown') item.y += step;
    commit();
  }
}

export function initInput(canvasElement) {
  canvas = canvasElement;
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => {
    if (app.tool === 'draw' && !gesture) { app.draft.hover = null; app.draft.guides = []; requestDraw(); }
  });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', () => { if (app.tool === 'draw') finishDrawing(); });
  window.addEventListener('keydown', onKeyDown);
}
