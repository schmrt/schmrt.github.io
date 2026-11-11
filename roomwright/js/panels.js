// Everything outside the canvas: the top bar, the tool buttons and hint, the Room, Furnish
// and Saved panels, and the inspector for whatever is selected.

import { formatLength, parseLength, formatArea } from './units.js';
import { polygonArea, isSimplePolygon } from './geometry.js';
import {
  CATALOG, ITEM_DEFS, OPENING_DEFAULTS, FLOOR_MATERIALS, FINISH_COLORS, PAINT_COLORS, FLOOR_COLORS, materialsFor,
} from './catalog.js';
import {
  app, commit, undo, redo, requestDraw, findSelected, getWalls, findWall, wallColor, findIssues, fitView,
  setTool, clampOpenings, addItem, addOpening, deleteSelection, duplicateSelection, rotateSelection,
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

/** Show a left-panel tab: 'room', 'furnish', 'saved', or (on phones) 'selected' for the inspector. */
export function setTab(tab) {
  $('#app').dataset.tab = tab;
  document.querySelectorAll('.tabs button').forEach(button => button.setAttribute('aria-selected', button.dataset.tab === tab));
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
    <div class="grp"><h3>Rotation</h3>
      <div class="row"><label for="f-rot">Degrees</label><input class="field" id="f-rot" data-f="rot" type="number" step="15" value="${Math.round(item.rot)}"></div>
      <div class="btns"><button class="btn small" data-act="rotate" data-v="-90">Turn left 90°</button><button class="btn small" data-act="rotate" data-v="90">Turn right 90°</button></div></div>
    <div class="grp"><h3>Finish</h3>
      <div class="row"><label for="f-mat">Material</label><select class="field" id="f-mat" data-f="material">${materialOptions}</select></div>
      <div class="chips">${swatches(FINISH_COLORS, item.color, 'color')}<input type="color" id="f-color" data-f="color" value="${item.color}" aria-label="Custom colour"></div></div>
    <div class="btns"><button class="btn small" data-act="duplicate">Duplicate</button><button class="btn small danger" data-act="delete">Delete</button></div>`;
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
      if (meters != null && meters >= 1.5 && meters <= 8) room.wallHeight = meters;
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
  if (app.tool === 'select') {
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
}

function initBar() {
  document.querySelector('.tabs').addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button) setTab(button.dataset.tab);
  });
  document.querySelector('.tools').addEventListener('click', event => {
    const button = event.target.closest('[data-tool]');
    if (button) setTool(button.dataset.tool);
  });
  $('#hint').addEventListener('click', event => {
    if (event.target.id === 'drawDone') finishDrawing();
    if (event.target.id === 'drawCancel') setTool('select');
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
  initSavedPanel();
}
