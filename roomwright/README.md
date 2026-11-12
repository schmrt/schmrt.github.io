# Roomwright

A room planner that runs entirely in the browser. Draw a room of any polygon shape, place
and size furniture, add windows, doors and outlets, and set colours and finishes. Then switch the
sheet to 3D to orbit around the room or walk through it.

There is no build step: plain HTML, CSS and JavaScript modules. The only dependency is
[three.js](https://threejs.org), which the 3D view loads from the jsDelivr CDN (see the import map
in `index.html`) the first time someone opens it. The plan itself works without it.

## Running it

The JavaScript is split into modules, and browsers refuse to load modules from a `file://`
address, so opening `index.html` by double-clicking will show a blank plan. Serve the folder
instead:

```
python3 -m http.server 8000
```

then open http://localhost:8000. On GitHub Pages it works as-is: put these files at the top
level of the repository (or in `/docs`) and turn on Pages.

## Files

| File | What it holds |
| --- | --- |
| `index.html` | Page structure only |
| `styles.css` | All styling. Colours are CSS custom properties with light and dark values |
| `js/main.js` | Entry point and the render loop |
| `js/state.js` | The plan data, undo/redo, selection, view, all actions, storage, saved designs, export/import |
| `js/view3d.js` | The 3D view: builds a three.js scene from the plan; orbit and walk cameras; click to select |
| `js/draw.js` | Canvas drawing: grid, room, furniture symbols, material patterns, openings, dimensions |
| `js/wallview.js` | The wall view: one wall face on, for hanging and dragging picture frames |
| `js/frames.js` | Suggested picture-frame layouts (row, grid, salon...) and their scoring (pure functions) |
| `js/input.js` | Mouse, touch and keyboard handling, hit testing, snapping |
| `js/panels.js` | Top bar, Room / Furnish / Saved panels, the inspector |
| `js/catalog.js` | Furniture catalog, materials, colour palettes, opening defaults, room templates |
| `js/geometry.js` | Polygon, wall and rectangle maths (pure functions) |
| `js/units.js` | Length parsing and formatting (pure functions) |

## How it fits together

- All shared state lives on the `app` object in `state.js`. The plan format is documented at the
  top of that file. All lengths are stored in metres; feet and inches are display only.
- Code never draws directly. It changes state, then calls `commit()` (for plan edits: records an
  undo step, autosaves, re-renders) or `requestDraw()` (for view-only changes). The loop in
  `main.js` redraws once per frame.
- Walls are identified by the id of their starting corner. Openings store that id plus a distance
  along the wall.
- An item's front faces +y in its own coordinates; `rot` is in degrees.

## Sectionals

The **Sectional** (Furnish, Seating) is an L-shaped sofa. Width and depth are its overall size;
the inspector adds a **seat depth** (how deep each run is) and which side the **return** is on.
Overlap checks, wall snapping and clicking all use the real L shape (`itemParts` in
`geometry.js`), so a coffee table can sit in the corner of the L without a warning.

## Picture frames

The **Frames** tab switches the sheet to the **Wall** view: the chosen wall seen face on, with its
windows, doors, outlets and any furniture standing against it.

- Add frames from the size presets or by typing a width and height (outside size of the frame).
- **Layout** suggests arrangements (a row, two rows on a centre line, grids, a feature frame with
  columns either side, packed and salon-style rows), scored for compactness and shape. Click one
  to hang the frames that way. The group is centred over the widest low piece against the wall
  (or a piece you pick, or the middle of the wall), with its centre at about 57 in and at least
  8 in above the furniture.
- Drag frames in the wall view to fine-tune; they snap to each other's edges, centres and the gap,
  and to the centre of the wall and the furniture. Arrow keys nudge, R turns a frame, Delete
  removes it. Frames covering a window or door, overlapping, or hanging behind furniture are
  outlined in red.
- Frames show as thin bars on the plan and as framed pictures in 3D.

## The 3D view

- The **Plan / 3D** switch at the top of the sheet swaps views. `setView()` in `panels.js` imports
  `view3d.js` on first use.
- The scene is rebuilt from scratch whenever the plan changes (it compares the plan's JSON each
  frame), so edits in the panels, the inspector, undo and redo all show up immediately.
- **Orbit:** drag to orbit, right-drag or two fingers to pan, scroll or pinch to zoom. Walls between
  the camera and the room are hidden so you can see in. Click anything to select it.
- **Walk:** eye height 1.6 m. Drag to look; W A S D or the arrow keys (or the on-screen pad) to
  move; Shift to go faster. You can't walk through walls or furniture. It starts just inside the
  first door.
- Each catalog `kind` has a builder in `BUILDERS` in `view3d.js`. A new kind without one shows as
  a plain box.

## Common changes

- **Add a piece of furniture:** add an entry to `CATALOG_SOURCE` in `catalog.js`. Reuse an
  existing `kind`, or add a new symbol function to `SYMBOLS` in `draw.js` and a 3D builder to
  `BUILDERS` in `view3d.js`.
- **Add a material:** add it to `MATERIALS` (or `RUG_MATERIALS` / `FLOOR_MATERIALS`) in
  `catalog.js` and add a pattern with the same key to `PATTERNS` in `draw.js`.
- **Add a room template:** add a corner list (in feet) to `ROOM_TEMPLATES` in `catalog.js` and a
  button with a matching `data-tpl` in `index.html`.

## Storage

The working plan autosaves to `localStorage` under `roomwright.plan.v1`, and saved designs under
`roomwright.library.v1`. Both are per browser and per site address. Export copies a design as
JSON text; import validates it in `normalizePlan()` before loading.

## Not built yet

- Wall-mounted pieces such as art and mirrors.
