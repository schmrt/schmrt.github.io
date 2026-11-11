// Entry point: load the plan, wire everything up, and run the render loop.

import { app, initPlan, loadLibrary } from './state.js';
import { initCanvas, draw } from './draw.js';
import { initInput } from './input.js';
import { initPanels, renderPanels, renderInspector } from './panels.js';

const canvas = document.querySelector('#plan');

initPlan();
loadLibrary();
initPanels();                                        // builds the catalog tiles, which initCanvas then paints
initCanvas(canvas, document.querySelector('#sheet'));
initInput(canvas);

// Nothing draws directly. Code that changes state sets flags in app.dirty (usually through
// commit(), requestDraw() or requestAll() in state.js) and this loop redraws once per frame.
function frame() {
  const { dirty } = app;
  if (dirty.panels) { dirty.panels = false; renderPanels(); }
  if (dirty.inspector) { dirty.inspector = false; renderInspector(); }
  if (dirty.draw && app.view.width > 1) {
    dirty.draw = false;
    try { draw(); } catch (error) { console.error(error); }
  }
  requestAnimationFrame(frame);
}
frame();
