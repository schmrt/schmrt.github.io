// Everything outside the canvas: the top bar, the tool buttons and hint, the Room, Furnish
// and Saved panels, and the inspector for whatever is selected.

import { INCH, formatLength, parseLength, formatArea } from './units.js';
import { polygonArea, isSimplePolygon } from './geometry.js';
import { suggestLayouts, artColor, frameBorders } from './frames.js';
import { frameWall, faceX, framesOn, piecesAgainst, frameProblems } from './wallview.js';
import {
  CATALOG, ITEM_DEFS, OPENING_DEFAULTS, FLOOR_MATERIALS, FINISH_COLORS, PAINT_COLORS, FLOOR_COLORS, materialsFor,
} from './catalog.js';
import {
  app, commit, undo, redo, requestDraw, findSelected, getWalls, findWall, wallColor, findIssues, fitView,
  setTool, setSelection, clampOpenings, fitSectional, addItem, addOpening, addFrame, deleteSelection, duplicateSelection, rotateSelection,
  applyTemplate, finishDrawing, clearItems, loadSample,
  saveToLibrary, openFromLibrary, deleteFromLibrary, exportPlanText, importPlanText,
} from './state.js';

const $ = selector => document.querySelector(selector);
const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const units = () => app.plan.units;
const length = meters => formatLength(meters, units());

/** A row of colour swatches. Clicking one fires the `data-act` action with the colour as `data-v`. */
function swatches(palette, current, action) {
  return palette.map(([name, hex]) =>
    `<button class="chip" style="background:${hex}" title="${name}" aria-label="${name}" ` +
    `aria-pressed="${hex.toLowerCase() === String(current).toLowerCase()}" data-act="${action}" data-v="${hex}"></button>`
  ).join('');
}

/**
 * Show a left-panel tab: 'room', 'furnish', 'frames', 'saved', or (on phones) 'selected' for the
 * inspector. The Frames tab brings up the wall view; leaving it for another panel goes back to the plan.
 */
export function setTab(tab) {
  $('#app').dataset.tab = tab;
  document.querySelectorAll('.tabs button').forEach(button => button.setAttribute('aria-selected', button.dataset.tab === tab));
  if (tab === 'frames' && app.sheetView !== 'wall') setView('wall');
  else if (tab !== 'frames' && tab !== 'selected' && app.sheetView === 'wall') setView('plan');
  app.dirty.panels = true;
}

/* ------------------------------------------------------------------ inspector */

function itemInspector(item) {
  const def = ITEM_DEFS[item.type];
  const issue = findIssues()[item.id];
  const materialOptions = Object.entries(materialsFor(item.type))
    .map(([key, label]) => `<option value="${key}"${key === item.material ? ' selected' : ''}>${label}</option>`).join('');
  return `
    <div class="grp"><p class="lbl">${escapeHtml(def.name)}</p>
      <input class="field" id="f-name" data-f="name" value="${escapeHtml(item.name)}" aria-label="Name" style="font:600 17px var(--f-ui)"></div>
    ${issue ? `<p class="warnbox">${issue === 'outside' ? 'Part of this piece is outside the walls.' : 'This overlaps another piece.'}</p>` : ''}
    <div class="grp"><h3>Size</h3><div class="three">
      <label>Width<input class="field" id="f-w" data-f="w" value="${length(item.w)}"></label>
      <label>Depth<input class="field" id="f-d" data-f="d" value="${length(item.d)}"></label>
      <label>Height<input class="field" id="f-h" data-f="h" value="${length(item.h)}"></label></div>
      <p class="note">${units() === 'metric' ? 'Plain numbers are centimetres. 1.8 m also works.' : 'Plain numbers are inches. 6\' 2" also works.'}</p></div>
    ${item.seat > 0 ? sectionalFields(item) : ''}
    <div class="grp"><h3>Rotation</h3>
      <div class="row"><label for="f-rot">Degrees</label><input class="field" id="f-rot" data-f="rot" type="number" step="15" value="${Math.round(item.rot)}"></div>
      <div class="btns"><button class="btn small" data-act="rotate" data-v="-90">Turn left 90°</button><button class="btn small" data-act="rotate" data-v="90">Turn right 90°</button></div></div>
    <div class="grp"><h3>Finish</h3>
      <div class="row"><label for="f-mat">Material</label><select class="field" id="f-mat" data-f="material">${materialOptions}</select></div>
      <div class="chips">${swatches(FINISH_COLORS, item.color, 'color')}<input type="color" id="f-color" data-f="color" value="${item.color}" aria-label="Custom colour"></div></div>
    <div class="btns"><button class="btn small" data-act="duplicate">Duplicate</button><button class="btn small danger" data-act="delete">Delete</button></div>`;
}

function sectionalFields(item) {
  const pressed = side => `aria-pressed="${item.side === side}"`;
  return `
    <div class="grp"><h3>Sectional</h3>
      <div class="row"><label for="f-seat">Seat depth</label><input class="field" id="f-seat" data-f="seat" value="${length(item.seat)}"></div>
      <div class="row"><span class="rowlbl">Return on</span><div class="seg" role="group" aria-label="Return side">
        <button data-act="side" data-v="left" ${pressed('left')}>Left</button><button data-act="side" data-v="right" ${pressed('right')}>Right</button></div></div>
      <p class="note">Width and depth are the overall size. Seat depth is how deep each run is, back to front. Left and right are as you face the sofa.</p></div>`;
}

const FRAME_PROBLEMS = {
  opening: 'This frame covers a window or door.',
  frame: 'This frame overlaps another frame.',
  furniture: 'This frame hangs down behind a piece of furniture.',
};

function frameInspector(frame) {
  const wall = findWall(frame.wall);
  const problem = frameProblems()[frame.id];
  return `
    <div class="grp"><p class="lbl">Wall ${wall.index + 1} · ${frame.w > frame.h ? 'landscape' : frame.w < frame.h ? 'portrait' : 'square'}</p><h2 class="title">Picture frame</h2></div>
    ${problem ? `<p class="warnbox">${FRAME_PROBLEMS[problem]}</p>` : ''}
    <div class="grp">
      <div class="row"><label for="f-fw">Width</label><input class="field" id="f-fw" data-f="fw" value="${length(frame.w)}"></div>
      <div class="row"><label for="f-fh">Height</label><input class="field" id="f-fh" data-f="fh" value="${length(frame.h)}"></div>
      <div class="row"><label for="f-alt">Centre at</label><input class="field" id="f-alt" data-f="alt" value="${length(frame.alt)}"></div>
      <div class="row"><label for="f-left">From left</label><input class="field" id="f-left" data-f="left" value="${length(faceX(wall, frame.pos) - frame.w / 2)}"></div>
      <p class="note">Sizes are the outside of the frame. "Centre at" is the height of its middle above the floor; "From left" is from the left end of the wall, as you face it, to the frame's left edge.</p></div>
    <div class="btns"><button class="btn small" data-act="rotate" data-v="90">Turn</button><button class="btn small" data-act="duplicate">Duplicate</button><button class="btn small danger" data-act="delete">Delete</button></div>`;
}

function openingInspector(opening) {
  const sillRow = opening.type === 'door' ? '' :
    `<div class="row"><label for="f-sill">${opening.type === 'window' ? 'Sill height' : 'Above floor'}</label><input class="field" id="f-sill" data-f="sill" value="${length(opening.sill)}"></div>`;
  return `
    <div class="grp"><p class="lbl">On the wall</p><h2 class="title">${OPENING_DEFAULTS[opening.type].name}</h2></div>
    <div class="grp">
      <div class="row"><label for="f-width">Width</label><input class="field" id="f-width" data-f="width" value="${length(opening.width)}"></div>
      <div class="row"><label for="f-height">Height</label><input class="field" id="f-height" data-f="height" value="${length(opening.height)}"></div>
      ${sillRow}
      <div class="row"><label for="f-pos">From corner</label><input class="field" id="f-pos" data-f="pos" value="${length(Math.max(0, opening.pos - opening.width / 2))}"></div>
      <p class="note">Measured from the wall's starting corner to the near edge. Drag it on the plan to slide it or move it to another wall.</p></div>
    <div class="btns"><button class="btn small danger" data-act="delete">Delete</button></div>`;
}

function wallInspector(wall) {
  const count = app.plan.openings.filter(o => o.wall === wall.id).length;
  const hasOwnPaint = !!app.plan.room.wallColors[wall.id];
  return `
    <div class="grp"><p class="lbl">Wall ${wall.index + 1} of ${app.plan.room.verts.length}</p><h2 class="title">${length(wall.length)} wall</h2></div>
    <div class="grp"><div class="row"><label for="f-len">Length</label><input class="field" id="f-len" data-f="length" value="${length(wall.length)}"></div>
      <p class="note">Changing the length moves this wall's far corner.</p></div>
    <div class="grp"><h3>Paint this wall</h3>
      <div class="chips">${swatches(PAINT_COLORS, wallColor(wall.id), 'paintWall')}<input type="color" id="f-wcol" data-f="paintWall" value="${wallColor(wall.id)}" aria-label="Custom wall colour"></div>
      ${hasOwnPaint ? '<div class="btns"><button class="btn small" data-act="unpaintWall">Match the other walls</button></div>' : ''}</div>
    <div class="grp"><h3>Add to this wall</h3>
      <div class="btns"><button class="btn small" data-act="addOpening" data-v="window">Window</button><button class="btn small" data-act="addOpening" data-v="door">Door</button><button class="btn small" data-act="addOpening" data-v="outlet">Outlet</button></div>
      <p class="note">${count ? `${count} ${count > 1 ? 'things are' : 'thing is'} on this wall.` : 'Nothing on this wall yet.'}</p></div>`;
}

function cornerInspector() {
  return `
    <div class="grp"><p class="lbl">Room shape</p><h2 class="title">Corner</h2><p class="note">Drag it on the plan. It lines up with other corners as you move it.</p></div>
    <div class="btns"><button class="btn small danger" data-act="delete"${app.plan.room.verts.length <= 3 ? ' disabled' : ''}>Remove corner</button></div>`;
}

function roomSummary() {
  const { plan } = app;
  const corners = plan.room.verts;
  const problems = Object.keys(findIssues()).length;
  const perimeter = getWalls().reduce((sum, wall) => sum + wall.length, 0);
  const countOf = type => plan.openings.filter(o => o.type === type).length;
  return `
    <div class="grp"><p class="lbl">Nothing selected</p><h2 class="title">Room summary</h2></div>
    ${isSimplePolygon(corners) ? '' : '<p class="warnbox">Two walls cross each other. Drag a corner to untangle them.</p>'}
    ${problems ? `<p class="warnbox">${problems} ${problems > 1 ? 'pieces need' : 'piece needs'} a look: overlapping or outside the walls. They are outlined in red dashes.</p>` : ''}
    <dl class="stats">
      <dt>Floor area</dt><dd>${formatArea(Math.abs(polygonArea(corners)), units())}</dd>
      <dt>Perimeter</dt><dd>${length(perimeter)}</dd>
      <dt>Walls</dt><dd>${corners.length}</dd>
      <dt>Ceiling</dt><dd>${length(plan.room.wallHeight)}</dd>
      <dt>Furniture and decor</dt><dd>${plan.items.length}</dd>
      <dt>Windows</dt><dd>${countOf('window')}</dd><dt>Doors</dt><dd>${countOf('door')}</dd><dt>Outlets</dt><dd>${countOf('outlet')}</dd>
    </dl>
    <div class="grp"><h3>Shortcuts</h3><ul class="keys">
      <li><kbd>R</kbd> turn 90° &nbsp; <kbd>Shift</kbd>+<kbd>R</kbd> turn 15°</li>
      <li><kbd>Arrows</kbd> nudge &nbsp; <kbd>Del</kbd> remove</li>
      <li><kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate &nbsp; <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo</li>
      <li><kbd>Alt</kbd> while dragging turns snapping off</li>
      <li>Scroll or pinch to zoom, drag the paper to pan</li></ul></div>`;
}

/** Rebuild the inspector for the current selection, keeping keyboard focus on the same field. */
export function renderInspector() {
  const panel = $('#insp');
  const focusedId = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : null;
  const { selection } = app;
  const selected = findSelected();
  let html = '';
  if (selection && selected) {
    if (selection.kind === 'item') html = itemInspector(selected);
    else if (selection.kind === 'opening') html = openingInspector(selected);
    else if (selection.kind === 'frame') html = frameInspector(selected);
    else if (selection.kind === 'wall') html = wallInspector(findWall(selection.id));
    else if (selection.kind === 'corner') html = cornerInspector();
  }
  panel.innerHTML = html || roomSummary();
  const field = focusedId && document.getElementById(focusedId);
  if (field) {
    field.focus();
    if (field.select && field.type !== 'color') { try { field.select(); } catch (e) { /* not selectable */ } }
  }
}

/**
 * Apply a value typed or picked in the inspector to the selected thing.
 * `field` is the input's data-f name. `done` is false while a colour picker is still being dragged.
 */
function applyInspectorField(field, value, done) {
  const { selection, plan } = app;
  const selected = findSelected();
  if (!selection || !selected) return;

  if (selection.kind === 'item') {
    const item = selected;
    if (field === 'name') item.name = value.trim() || ITEM_DEFS[item.type].name;
    else if (field === 'w' || field === 'd' || field === 'h') {
      const meters = parseLength(value, units());
      if (meters != null && meters > 0) item[field] = Math.max(field === 'h' ? 0.005 : 0.05, Math.min(12, meters));
      fitSectional(item);
    } else if (field === 'seat') {
      const meters = parseLength(value, units());
      if (meters != null && meters > 0) { item.seat = meters; fitSectional(item); }
    } else if (field === 'rot') {
      const degrees = parseFloat(value);
      if (!isNaN(degrees)) item.rot = ((degrees % 360) + 360) % 360;
    } else if (field === 'material') item.material = value;
    else if (field === 'color') item.color = value;
  } else if (selection.kind === 'opening') {
    const opening = selected;
    const meters = parseLength(value, units());
    const wall = findWall(opening.wall);
    if (meters != null && wall) {
      if (field === 'width' && meters > 0) opening.width = Math.max(0.03, Math.min(wall.length - 0.02, meters));
      else if (field === 'height' && meters > 0) opening.height = Math.min(meters, plan.room.wallHeight);
      else if (field === 'sill') opening.sill = Math.max(0, Math.min(meters, plan.room.wallHeight - 0.05));
      else if (field === 'pos') opening.pos = meters + opening.width / 2;
      clampOpenings();
    }
  } else if (selection.kind === 'frame') {
    const frame = selected;
    const meters = parseLength(value, units());
    const wall = findWall(frame.wall);
    if (meters != null && wall) {
      if (field === 'fw' && meters > 0) frame.w = Math.max(0.05, meters);
      else if (field === 'fh' && meters > 0) frame.h = Math.max(0.05, meters);
      else if (field === 'alt') frame.alt = meters;
      else if (field === 'left') frame.pos = faceX(wall, meters + frame.w / 2);
      clampOpenings();
    }
  } else if (selection.kind === 'wall') {
    const wall = findWall(selection.id);
    if (!wall) return;
    if (field === 'length') {
      const meters = parseLength(value, units());
      if (meters != null && meters >= 0.1) {
        wall.b.x = wall.a.x + wall.ux * meters;
        wall.b.y = wall.a.y + wall.uy * meters;
        clampOpenings();
      }
    } else if (field === 'paintWall') plan.room.wallColors[wall.id] = value;
  }
  requestDraw();
  if (done) { app.dirty.inspector = true; commit(); }
}

function initInspector() {
  const panel = $('#insp');
  panel.addEventListener('change', event => {
    const field = event.target.dataset.f;
    if (field) applyInspectorField(field, event.target.value, true);
  });
  panel.addEventListener('input', event => { // live preview while dragging a colour picker
    const field = event.target.dataset.f;
    if (field && event.target.type === 'color') applyInspectorField(field, event.target.value, false);
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.dataset.f && event.target.tagName === 'INPUT') event.target.blur();
  });
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const { act: action, v: value } = button.dataset;
    if (action === 'rotate') rotateSelection(+value);
    else if (action === 'duplicate') duplicateSelection();
    else if (action === 'delete') deleteSelection();
    else if (action === 'color' || action === 'paintWall') applyInspectorField(action, value, true);
    else if (action === 'unpaintWall') { delete app.plan.room.wallColors[app.selection.id]; commit(); }
    else if (action === 'side') { const item = findSelected(); if (item) { item.side = value; commit(); } }
    else if (action === 'addOpening') addOpening(value);
  });
}

/* ------------------------------------------------------------------ room and furnish panels */

function buildCatalog() {
  $('#p-furnish').innerHTML = CATALOG.map(({ group, items }) => `
    <div class="grp"><h3>${group}</h3><div class="cat">${items.map(def =>
      `<button class="tile" data-add="${def.type}"><canvas data-type="${def.type}" width="60" height="42"></canvas>${def.name}</button>`).join('')}</div></div>`).join('') + `
    <div class="grp"><p class="note">Click a piece to drop it in the room. Sizes are typical; change them in the inspector.</p>
      <div class="btns"><button class="btn small danger" id="clearItems">Remove all furniture</button><button class="btn small" id="loadSample">Load sample room</button></div></div>`;
  $('#floorMat').innerHTML = Object.entries(FLOOR_MATERIALS).map(([key, label]) => `<option value="${key}">${label}</option>`).join('');
}

function initRoomPanel() {
  const panel = $('#p-room');
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const { room } = app.plan;
    if (button.dataset.tpl) applyTemplate(button.dataset.tpl);
    else if (button.dataset.open) addOpening(button.dataset.open);
    else if (button.dataset.act === 'paintAll') { room.wallColor = button.dataset.v; room.wallColors = {}; commit(); }
    else if (button.dataset.act === 'floorColor') { room.floor.color = button.dataset.v; commit(); }
  });
  panel.addEventListener('input', event => { // live preview from the colour pickers
    const { room } = app.plan;
    if (event.target.id === 'wallPick') { room.wallColor = event.target.value; room.wallColors = {}; requestDraw(); }
    if (event.target.id === 'floorPick') { room.floor.color = event.target.value; requestDraw(); }
  });
  panel.addEventListener('change', event => {
    const { room } = app.plan;
    const target = event.target;
    if (target.id === 'floorMat') room.floor.material = target.value;
    if (target.id === 'ceil') {
      const meters = parseLength(target.value, units());
      if (meters != null && meters >= 1.5 && meters <= 8) { room.wallHeight = meters; clampOpenings(); }
      target.value = length(room.wallHeight);
    }
    commit();
  });
  $('#p-furnish').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.add) addItem(button.dataset.add);
    else if (button.id === 'clearItems') clearItems();
    else if (button.id === 'loadSample') loadSample();
  });
}

/* ------------------------------------------------------------------ frames panel */

/** Common frame sizes, outside dimensions: [width, height (metres), label]. */
const FRAME_PRESETS = {
  imperial: [[5, 7], [8, 10], [11, 14], [12, 12], [16, 20], [18, 24], [24, 36]].map(([w, h]) => [w * INCH, h * INCH, `${w}×${h}`]),
  metric: [[13, 18], [20, 25], [30, 40], [30, 30], [40, 50], [50, 70], [60, 90]].map(([w, h]) => [w / 100, h / 100, `${w}×${h}`]),
};
/** The layouts on show, with where each would put the frames: [{ layout, placed: [{ id, x, alt }] }]. */
let shownLayouts = [];

/** The piece the frames should hang over, from the "Centre over" setting, or null for the middle of the wall. */
function frameAnchor(wall, pieces = piecesAgainst(wall)) {
  const { anchor } = app.frameOptions;
  if (anchor === 'wall') return null;
  const named = pieces.find(p => p.item.id === anchor);
  if (named) return named;
  // Automatic: the widest low piece (a sofa, console, bed or dresser, not a bookshelf).
  return pieces.filter(p => p.top < 1.3 && p.right - p.left > 0.6)
    .sort((a, b) => (b.right - b.left) - (a.right - a.left))[0] || null;
}

/** Size limits for suggested layouts on this wall. */
function layoutLimits(wall, frames, anchor) {
  const ceiling = app.plan.room.wallHeight;
  const { gap, maxWidth } = app.frameOptions;
  const widest = Math.max(...frames.map(f => f.w));
  // About three quarters of the furniture's width looks right; on a bare wall, keep to the middle stretch.
  const automatic = anchor ? (anchor.right - anchor.left) * 0.75 : Math.min(wall.length * 0.6, 2.4);
  const lowest = anchor ? anchor.top + 8 * INCH : 0.6;
  return {
    gap,
    maxWidth: Math.min(wall.length - 0.1, Math.max(widest, maxWidth || automatic)),
    maxHeight: Math.max(0.3, ceiling - 4 * INCH - lowest),
    automatic,
  };
}

/** Where a layout would hang each frame, in face coordinates: centred over the anchor (or the wall) at the chosen height. */
function placeLayout(wall, layout, anchor) {
  const ceiling = app.plan.room.wallHeight;
  let x = anchor ? (anchor.left + anchor.right) / 2 : wall.length / 2;
  x = Math.max(layout.width / 2, Math.min(wall.length - layout.width / 2, x));
  let alt = app.frameOptions.centre;
  if (anchor) alt = Math.max(alt, anchor.top + 8 * INCH + layout.height / 2); // keep 8 in clear of the furniture
  alt = Math.max(layout.height / 2, Math.min(ceiling - 3 * INCH - layout.height / 2, alt));
  return layout.spots.map(spot => ({ id: spot.id, x: x + spot.x, alt: alt + spot.y }));
}

/** A small picture of a layout on the wall, with the piece it hangs over. */
function drawLayoutThumb(canvas, wall, placed, anchor) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
  const W = canvas.clientWidth || 110, H = canvas.clientHeight || 72;
  canvas.width = Math.round(W * ratio);
  canvas.height = Math.round(H * ratio);
  const c = canvas.getContext('2d');
  c.setTransform(ratio, 0, 0, ratio, 0, 0);
  c.fillStyle = wallColor(wall.id);
  c.fillRect(0, 0, W, H);
  const byId = new Map(framesOn(wall).map(f => [f.id, f]));
  let minX = Infinity, maxX = -Infinity, minAlt = Infinity, maxAlt = -Infinity;
  for (const p of placed) {
    const f = byId.get(p.id);
    minX = Math.min(minX, p.x - f.w / 2); maxX = Math.max(maxX, p.x + f.w / 2);
    minAlt = Math.min(minAlt, p.alt - f.h / 2); maxAlt = Math.max(maxAlt, p.alt + f.h / 2);
  }
  if (anchor) { minX = Math.min(minX, anchor.left); maxX = Math.max(maxX, anchor.right); minAlt = 0; }
  const scale = Math.min((W - 12) / (maxX - minX), (H - 12) / (maxAlt - minAlt));
  const midX = (minX + maxX) / 2, midAlt = (minAlt + maxAlt) / 2;
  const sx = x => W / 2 + (x - midX) * scale, sy = alt => H / 2 - (alt - midAlt) * scale;
  if (anchor) {
    c.globalAlpha = 0.75;
    c.fillStyle = anchor.item.color;
    c.fillRect(sx(anchor.left), sy(anchor.top), (anchor.right - anchor.left) * scale, anchor.top * scale);
    c.globalAlpha = 1;
  }
  for (const p of placed) {
    const f = byId.get(p.id);
    const { moulding, mat } = frameBorders(f.w, f.h);
    const x = sx(p.x - f.w / 2), y = sy(p.alt + f.h / 2), w = f.w * scale, h = f.h * scale;
    const m = Math.max(1, moulding * scale), inner = Math.max(m + 1, (moulding + mat) * scale);
    c.fillStyle = '#2e2c2b'; c.fillRect(x, y, w, h);
    c.fillStyle = '#f6f4ee'; c.fillRect(x + m, y + m, w - 2 * m, h - 2 * m);
    if (w > 2 * inner && h > 2 * inner) { c.fillStyle = artColor(f.id); c.fillRect(x + inner, y + inner, w - 2 * inner, h - 2 * inner); }
  }
}

function renderFramesPanel() {
  const panel = $('#p-frames');
  if ($('#app').dataset.tab !== 'frames') return;
  const focusedId = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : null;
  const typed = { w: $('#frNewW') ? $('#frNewW').value : '', h: $('#frNewH') ? $('#frNewH').value : '' };
  const wall = frameWall();
  const frames = framesOn(wall);
  const options = app.frameOptions;
  const pieces = piecesAgainst(wall);
  const anchor = frameAnchor(wall, pieces);
  const chosenId = app.selection && app.selection.kind === 'frame' ? app.selection.id : null;
  const problems = frameProblems();
  const limits = frames.length ? layoutLimits(wall, frames, anchor) : null;
  shownLayouts = limits
    ? suggestLayouts(frames, limits).map(layout => ({ layout, placed: placeLayout(wall, layout, anchor) }))
    : [];

  const wallOptions = getWalls().map(w => {
    const count = app.plan.frames.filter(f => f.wall === w.id).length;
    return `<option value="${escapeHtml(w.id)}"${w.id === wall.id ? ' selected' : ''}>Wall ${w.index + 1} · ${length(w.length)}${count ? ` · ${count} frame${count > 1 ? 's' : ''}` : ''}</option>`;
  }).join('');
  const rows = frames.map(f => {
    const id = escapeHtml(f.id);
    return `<li data-frame="${id}"${f.id === chosenId ? ' aria-current="true"' : ''}>
      <span class="art" style="background:${artColor(f.id)}"${problems[f.id] ? ' data-warn="true" title="' + FRAME_PROBLEMS[problems[f.id]] + '"' : ''}></span>
      <input class="field" id="fr-w-${id}" data-fr="w" value="${length(f.w)}" aria-label="Width">
      <span class="x">×</span>
      <input class="field" id="fr-h-${id}" data-fr="h" value="${length(f.h)}" aria-label="Height">
      <button class="btn small icon" data-fract="turn" title="Turn" aria-label="Turn">&#8635;</button>
      <button class="btn small icon danger" data-fract="remove" title="Remove" aria-label="Remove">&times;</button></li>`;
  }).join('');
  const anchorOptions = pieces.map(p =>
    `<option value="${escapeHtml(p.item.id)}"${options.anchor === p.item.id ? ' selected' : ''}>${escapeHtml(p.item.name)}</option>`).join('');
  const automaticName = (() => {
    const saved = options.anchor; options.anchor = 'auto';
    const pick = frameAnchor(wall, pieces); options.anchor = saved;
    return pick ? ` (${escapeHtml(pick.item.name)})` : ' (middle of the wall)';
  })();

  panel.innerHTML = `
    <div class="grp"><h3>Wall</h3>
      <div class="row"><label for="frWall">Hang on</label><select class="field" id="frWall">${wallOptions}</select></div>
      <p class="note">The sheet shows this wall face on. Drag frames there to move them.</p></div>
    <div class="grp"><h3>Frames on this wall</h3>
      ${frames.length ? `<ul class="frlist">${rows}</ul>` : '<p class="note">No frames yet. Add some below.</p>'}
      <p class="lbl">Add a frame</p>
      <div class="btns">${FRAME_PRESETS[units()].map(([w, h, name]) => `<button class="btn small" data-frpreset="${w},${h}">${name}</button>`).join('')}</div>
      <div class="frnew"><input class="field" id="frNewW" placeholder="Width" aria-label="New frame width" value="${escapeHtml(typed.w)}">
        <span class="x">×</span><input class="field" id="frNewH" placeholder="Height" aria-label="New frame height" value="${escapeHtml(typed.h)}">
        <button class="btn small" id="frAdd">Add</button></div>
      <p class="note">Sizes are the outside of the frame, width × height. Plain numbers are ${units() === 'metric' ? 'centimetres' : 'inches'}.</p></div>
    <div class="grp"><h3>Layout</h3>
      <div class="row"><label for="frAnchor">Centre over</label><select class="field" id="frAnchor">
        <option value="auto"${options.anchor === 'auto' || !pieces.some(p => p.item.id === options.anchor) && options.anchor !== 'wall' ? ' selected' : ''}>Automatic${automaticName}</option>
        <option value="wall"${options.anchor === 'wall' ? ' selected' : ''}>Middle of the wall</option>${anchorOptions}</select></div>
      <div class="row"><label for="frCentre">Centre at</label><input class="field" id="frCentre" value="${length(options.centre)}"></div>
      <div class="row"><label for="frGap">Gap</label><input class="field" id="frGap" value="${length(options.gap)}"></div>
      <div class="row"><label for="frMax">Max width</label><input class="field" id="frMax" value="${options.maxWidth ? length(options.maxWidth) : ''}" placeholder="Auto (${limits ? length(Math.min(limits.automatic, wall.length)) : 'fits the space'})"></div>
      ${shownLayouts.length ? `<div class="layouts">${shownLayouts.map(({ layout }, i) =>
        `<button class="layout" data-layout="${i}"><canvas aria-hidden="true"></canvas><span>${layout.name}</span></button>`).join('')}</div>
      <p class="note">Pick a layout to hang the frames that way, then drag them on the wall to fine-tune. Gallery height is about 57" to the centre; over furniture the group stays at least 8" above it.</p>`
      : '<p class="note">Add frames to see suggested layouts.</p>'}</div>`;

  panel.querySelectorAll('.layout canvas').forEach((canvas, i) => drawLayoutThumb(canvas, wall, shownLayouts[i].placed, anchor));
  const field = focusedId && document.getElementById(focusedId);
  if (field) field.focus();
}

function initFramesPanel() {
  const panel = $('#p-frames');
  const addTyped = () => {
    const w = parseLength($('#frNewW').value, units()), h = parseLength($('#frNewH').value, units());
    if (!(w > 0) || !(h > 0)) { $('#frNewW').focus(); return; }
    $('#frNewW').value = $('#frNewH').value = '';
    addFrame(frameWall().id, Math.max(0.05, w), Math.max(0.05, h));
  };
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    const row = event.target.closest('[data-frame]');
    const frame = row && app.plan.frames.find(f => f.id === row.dataset.frame);
    if (button && button.dataset.frpreset) {
      const [w, h] = button.dataset.frpreset.split(',').map(Number);
      addFrame(frameWall().id, w, h);
    } else if (button && button.id === 'frAdd') {
      addTyped();
    } else if (button && button.dataset.layout) {
      const wall = frameWall();
      const shown = shownLayouts[+button.dataset.layout];
      if (!shown) return;
      for (const spot of shown.placed) {
        const f = app.plan.frames.find(x => x.id === spot.id);
        if (f) { f.pos = faceX(wall, spot.x); f.alt = spot.alt; }
      }
      clampOpenings();
      commit();
    } else if (button && frame && button.dataset.fract === 'turn') {
      [frame.w, frame.h] = [frame.h, frame.w];
      clampOpenings();
      commit();
    } else if (button && frame && button.dataset.fract === 'remove') {
      app.plan.frames = app.plan.frames.filter(f => f !== frame);
      if (app.selection && app.selection.id === frame.id) app.selection = null;
      commit();
    } else if (frame && !event.target.closest('input')) {
      setSelection({ kind: 'frame', id: frame.id });
    }
  });
  panel.addEventListener('focusin', event => { // focusing a frame's size field selects that frame
    const row = event.target.closest('[data-frame]');
    if (row && event.target.dataset.fr) setSelection({ kind: 'frame', id: row.dataset.frame });
  });
  panel.addEventListener('change', event => {
    const target = event.target;
    const options = app.frameOptions;
    if (target.id === 'frWall') { app.frameWall = target.value; setSelection({ kind: 'wall', id: target.value }); return; }
    if (target.id === 'frAnchor') options.anchor = target.value;
    else if (target.id === 'frCentre' || target.id === 'frGap' || target.id === 'frMax') {
      const meters = target.value.trim() ? parseLength(target.value, units()) : null;
      if (target.id === 'frCentre' && meters > 0) options.centre = meters;
      if (target.id === 'frGap' && meters != null) options.gap = Math.min(0.5, meters);
      if (target.id === 'frMax') options.maxWidth = meters > 0 ? meters : null;
    } else if (target.dataset.fr) {
      const frame = app.plan.frames.find(f => f.id === target.closest('[data-frame]').dataset.frame);
      const meters = parseLength(target.value, units());
      if (frame && meters > 0) { frame[target.dataset.fr] = Math.max(0.05, meters); clampOpenings(); commit(); }
    }
    app.dirty.panels = true;
  });
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.target.tagName !== 'INPUT') return;
    if (event.target.id === 'frNewW' || event.target.id === 'frNewH') addTyped();
    else event.target.blur();
  });
}

/* ------------------------------------------------------------------ saved designs panel */

/** Id of the saved design whose Delete button has been clicked once and is waiting for a second click. */
let pendingDelete = null;
const say = (selector, text) => { $(selector).textContent = text; };

function renderLibrary() {
  const rows = app.library.slice().sort((a, b) => b.saved - a.saved).map(entry => {
    let info = new Date(entry.saved).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    try { info += ` · ${formatArea(Math.abs(polygonArea(entry.data.room.verts)), units())} · ${entry.data.items.length} pieces`; } catch (e) { /* odd data: date only */ }
    const id = escapeHtml(entry.id);
    return `<li><div><b>${escapeHtml(entry.name)}</b><small>${escapeHtml(info)}</small></div><div class="btns">
      <button class="btn small" data-lib="open" data-id="${id}">Open</button>
      <button class="btn small danger" data-lib="delete" data-id="${id}">${pendingDelete === entry.id ? 'Confirm delete' : 'Delete'}</button></div></li>`;
  });
  $('#lib').innerHTML = rows.join('') || '<li><div><small>No saved designs yet.</small></div></li>';
}

function importFromText(text) {
  const name = importPlanText(text);
  if (name == null) {
    say('#impMsg', String(text).trim()
      ? 'That is not a Roomwright design. Paste the full text exactly as it was exported.'
      : 'Paste design text in the box first, or choose a file.');
    return;
  }
  $('#impText').value = '';
  say('#impMsg', `Loaded "${name}". Undo returns to the plan you had before.`);
}

function initSavedPanel() {
  $('#saveDesign').addEventListener('click', () => {
    const result = saveToLibrary();
    pendingDelete = null;
    renderLibrary();
    say('#libMsg', result.stored
      ? `${result.updated ? 'Updated' : 'Saved'} "${result.name}". To keep a separate copy, rename the plan at the top and save again.`
      : 'This browser would not store the design. Use Export below to keep a copy.');
  });
  $('#lib').addEventListener('click', event => {
    const button = event.target.closest('[data-lib]');
    if (!button) return;
    const id = button.dataset.id;
    if (button.dataset.lib === 'open') {
      pendingDelete = null;
      const name = openFromLibrary(id);
      say('#libMsg', name != null ? `Opened "${name}". Undo returns to the plan you had before.` : 'That saved design could not be read.');
    } else if (pendingDelete === id) {
      pendingDelete = null;
      say('#libMsg', `Deleted "${deleteFromLibrary(id)}".`);
    } else {
      pendingDelete = id; // first click arms the button; the second click deletes
    }
    renderLibrary();
  });
  $('#exportBtn').addEventListener('click', () => {
    const text = exportPlanText();
    const box = $('#expText');
    // Some browsers and embedded views refuse clipboard access; then show the text to copy by hand.
    const showForManualCopy = () => {
      box.hidden = false; box.value = text; box.focus(); box.select();
      say('#expMsg', 'Copying was blocked here. The text is selected below: copy it, then paste it into a note or a file.');
    };
    try {
      navigator.clipboard.writeText(text).then(() => {
        box.hidden = true;
        say('#expMsg', `Copied "${app.plan.name}". Paste it into a note or a file to keep it.`);
      }, showForManualCopy);
    } catch (e) { showForManualCopy(); }
  });
  $('#impBtn').addEventListener('click', () => importFromText($('#impText').value));
  $('#impFile').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => importFromText(reader.result);
    reader.onerror = () => say('#impMsg', 'That file could not be read.');
    reader.readAsText(file);
    event.target.value = ''; // so choosing the same file again still fires a change
  });
}

/* ------------------------------------------------------------------ top bar, tools, hint */

function renderHint() {
  const hint = $('#hint');
  const traced = app.draft.points.length;
  if (app.sheetView === 'wall') {
    const wall = frameWall();
    hint.innerHTML = '<button class="btn small" id="wallPrev" aria-label="Previous wall">&lsaquo;</button>' +
      `<span>Wall ${wall.index + 1} of ${app.plan.room.verts.length}${app.view.width < 560 ? '' : ', face on. Drag frames to move them; arrows nudge, R turns.'}</span>` +
      '<button class="btn small" id="wallNext" aria-label="Next wall">&rsaquo;</button>';
  } else if (app.tool === 'select') {
    hint.innerHTML = '<span>Drag a piece to move it, drag its handle to turn it. Click a wall to paint or measure it.</span>';
  } else if (app.tool === 'walls') {
    hint.innerHTML = '<span>Drag a corner to reshape the room. Click + on a wall to add a corner.</span>';
  } else {
    hint.innerHTML = `<span>${traced < 3 ? 'Click to place each corner of the new room.' : 'Click the first corner to close the room.'}</span>` +
      (traced >= 3 ? '<button class="btn small" id="drawDone">Finish</button>' : '') +
      '<button class="btn small" id="drawCancel">Cancel</button>';
  }
  document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', button.dataset.tool === app.tool));
}

/* ------------------------------------------------------------------ plan / 3D switch */

/** The 3D module, loaded the first time someone opens 3D so the plan works without it. */
let view3d = null;

async function setView(view) {
  const sheet = $('#sheet');
  sheet.dataset.view = view;
  app.sheetView = view;
  app.dirty.panels = true;
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', button.dataset.view === view));
  if (view === 'wall' && $('#app').dataset.tab !== 'frames') setTab('frames');
  if (view !== '3d') { if (view3d) view3d.hide(); requestDraw(); return; }
  if (!view3d) {
    $('#hint3d').innerHTML = '<span>Loading the 3D view…</span>';
    try { view3d = await import('./view3d.js'); }
    catch (error) {
      console.error(error);
      $('#hint3d').innerHTML = '<span>The 3D view could not load. It downloads three.js the first time, so check the connection and try again.</span>';
      return;
    }
  }
  if (sheet.dataset.view === '3d') view3d.show($('#stage3d'));
}

/** Refresh everything outside the inspector from app state. Cheap enough to run after every change. */
export function renderPanels() {
  const { plan } = app;
  $('#wallChips').innerHTML = swatches(PAINT_COLORS, plan.room.wallColor, 'paintAll') +
    `<input type="color" id="wallPick" value="${plan.room.wallColor}" aria-label="Custom wall colour">`;
  $('#floorChips').innerHTML = swatches(FLOOR_COLORS, plan.room.floor.color, 'floorColor') +
    `<input type="color" id="floorPick" value="${plan.room.floor.color}" aria-label="Custom floor colour">`;
  $('#floorMat').value = plan.room.floor.material;
  if (document.activeElement !== $('#ceil')) $('#ceil').value = length(plan.room.wallHeight);
  if (document.activeElement !== $('#planName')) $('#planName').value = plan.name;
  $('#uImp').setAttribute('aria-pressed', units() === 'imperial');
  $('#uMet').setAttribute('aria-pressed', units() === 'metric');
  $('#undo').disabled = !app.undoStack.length;
  $('#redo').disabled = !app.redoStack.length;
  $('#readout').textContent = `${formatArea(Math.abs(polygonArea(plan.room.verts)), units())} · ${plan.items.length} pieces`;
  renderHint();
  renderLibrary();
  renderFramesPanel();
}

function initBar() {
  document.querySelector('.tabs').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button) setTab(button.dataset.tab);
  });
  document.querySelector('.tools').addEventListener('click', event => {
    const button = event.target.closest('[data-tool]');
    if (button) setTool(button.dataset.tool);
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) setView(viewButton.dataset.view);
  });
  $('#hint').addEventListener('click', event => {
    if (event.target.id === 'drawDone') finishDrawing();
    if (event.target.id === 'drawCancel') setTool('select');
    if (event.target.id === 'wallPrev' || event.target.id === 'wallNext') {
      const walls = getWalls();
      const step = event.target.id === 'wallNext' ? 1 : -1;
      const next = walls[(frameWall().index + step + walls.length) % walls.length];
      app.frameWall = next.id;
      setSelection({ kind: 'wall', id: next.id });
    }
  });
  $('#fit').addEventListener('click', fitView);
  $('#planName').addEventListener('change', event => { app.plan.name = event.target.value.trim() || 'Untitled room'; commit(); });
  $('#uImp').addEventListener('click', () => { app.plan.units = 'imperial'; commit(); });
  $('#uMet').addEventListener('click', () => { app.plan.units = 'metric'; commit(); });
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
}

/** Build the static parts of the panels and attach their event handlers. Call once at startup. */
export function initPanels() {
  buildCatalog();
  initBar();
  initInspector();
  initRoomPanel();
  initFramesPanel();
  initSavedPanel();
}
