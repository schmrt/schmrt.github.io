# Roomwright

A 2D room planner that runs entirely in the browser. Draw a room of any polygon shape, place
and size furniture, add windows, doors and outlets, and set colours and finishes.

There is no build step and no dependencies: plain HTML, CSS and JavaScript modules.

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
| `js/draw.js` | Canvas drawing: grid, room, furniture symbols, material patterns, openings, dimensions |
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

## Common changes

- **Add a piece of furniture:** add an entry to `CATALOG_SOURCE` in `catalog.js`. Reuse an
  existing `kind`, or add a new symbol function to `SYMBOLS` in `draw.js`.
- **Add a material:** add it to `MATERIALS` (or `RUG_MATERIALS` / `FLOOR_MATERIALS`) in
  `catalog.js` and add a pattern with the same key to `PATTERNS` in `draw.js`.
- **Add a room template:** add a corner list (in feet) to `ROOM_TEMPLATES` in `catalog.js` and a
  button with a matching `data-tpl` in `index.html`.

## Storage

The working plan autosaves to `localStorage` under `roomwright.plan.v1`, and saved designs under
`roomwright.library.v1`. Both are per browser and per site address. Export copies a design as
JSON text; import validates it in `normalizePlan()` before loading.

## Not built yet

- A 3D view. Heights are already stored for every item and opening.
- Wall-mounted pieces such as art and mirrors.
