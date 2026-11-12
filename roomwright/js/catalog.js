// The furniture catalog, materials, colour palettes, opening defaults and room templates.
// To add a piece of furniture: add an entry here, and if it needs a new plan symbol,
// add a matching `kind` to SYMBOLS in draw.js.

import { INCH } from './units.js';

/**
 * Each entry: [type, display name, kind, [width, depth, height] in inches, default material, default colour, extra].
 * `type` is what gets stored on a placed item. `kind` picks the plan symbol and behaviour,
 * so several types can share one kind (a sofa and an armchair are both kind "sofa").
 * `extra` (optional) holds more fields copied onto each new item, e.g. a sectional's seat depth.
 */
const CATALOG_SOURCE = [
  ['Seating', [
    ['sofa', 'Sofa', 'sofa', [84, 36, 32], 'fabric', '#3f5d73'],
    ['sectional', 'Sectional', 'lsofa', [112, 84, 32], 'fabric', '#3f5d73', { seat: 38 * INCH, side: 'right' }],
    ['armchair', 'Armchair', 'sofa', [34, 34, 32], 'leather', '#a86b3c'],
    ['chair', 'Dining chair', 'chair', [18, 20, 34], 'wood', '#2e2c2b'],
    ['office', 'Office chair', 'office', [25, 25, 38], 'fabric', '#4b4f55'],
  ]],
  ['Tables', [
    ['dining', 'Dining table', 'table', [72, 36, 30], 'wood', '#8a5a3a'],
    ['round', 'Round table', 'rtable', [42, 42, 30], 'wood', '#8a5a3a'],
    ['coffee', 'Coffee table', 'table', [44, 24, 17], 'wood', '#8a5a3a'],
    ['side', 'Side table', 'rtable', [20, 20, 22], 'wood', '#c9a577'],
    ['desk', 'Desk', 'desk', [55, 26, 30], 'painted', '#f1efe9'],
  ]],
  ['Storage', [
    ['bookshelf', 'Bookshelf', 'shelf', [36, 12, 75], 'wood', '#8a5a3a'],
    ['dresser', 'Dresser', 'chest', [48, 19, 34], 'wood', '#c9a577'],
    ['nightstand', 'Nightstand', 'chest', [20, 16, 22], 'wood', '#c9a577'],
    ['wardrobe', 'Wardrobe', 'wardrobe', [48, 24, 78], 'painted', '#f1efe9'],
    ['media', 'TV console', 'media', [63, 16, 20], 'wood', '#4a3528'],
  ]],
  ['Beds', [
    ['queen', 'Queen bed', 'bed', [60, 80, 22], 'fabric', '#7d8c6a'],
    ['twin', 'Twin bed', 'bed', [39, 75, 22], 'fabric', '#5f7896'],
  ]],
  ['Lighting', [
    ['flamp', 'Floor lamp', 'lamp', [16, 16, 62], 'metal', '#f3e6c8'],
    ['tlamp', 'Table lamp', 'lamp', [11, 11, 20], 'painted', '#f3e6c8'],
  ]],
  ['Rugs and decor', [
    ['rug', 'Rug', 'rug', [96, 66, 0.5], 'border', '#b4573a'],
    ['rrug', 'Round rug', 'rrug', [72, 72, 0.5], 'weave', '#d2a43c'],
    ['plant', 'Plant', 'plant', [20, 20, 44], 'painted', '#b8694d'],
    ['box', 'Custom box', 'box', [36, 36, 36], 'painted', '#9a9da1'],
  ]],
];

/** Catalog grouped for the Furnish panel: [{ group, items: [def, ...] }]. Sizes are in metres. */
export const CATALOG = CATALOG_SOURCE.map(([group, entries]) => ({
  group,
  items: entries.map(([type, name, kind, size, material, color, extra]) => ({
    type, name, kind, material, color, extra: extra || null,
    width: size[0] * INCH, depth: size[1] * INCH, height: size[2] * INCH,
  })),
}));

/** Look up a catalog definition by item type. */
export const ITEM_DEFS = {};
for (const { items } of CATALOG) for (const def of items) ITEM_DEFS[def.type] = def;

// Behaviour flags.
/** Rugs lie flat: other pieces can sit on top of them without counting as an overlap. */
export const isFlat = kind => kind === 'rug' || kind === 'rrug';
/** Pieces with a top that a table lamp can sit on, and that chairs can tuck under. */
export const isSurface = kind => ['table', 'rtable', 'desk', 'chest', 'media'].includes(kind);
/** Chairs may overlap a table or desk without a warning. */
export const isTuckable = kind => kind === 'chair' || kind === 'office';
/** Small pieces that sit on top of furniture, so they never count as overlapping. */
export const isTabletop = type => type === 'tlamp';

// Materials. Keys are stored on items; values are the labels shown in the inspector.
// Each key (except "painted", "stripes" and "border") has a pattern in draw.js.
export const MATERIALS = { wood: 'Wood', painted: 'Painted', fabric: 'Fabric', leather: 'Leather', metal: 'Metal', stone: 'Stone' };
export const RUG_MATERIALS = { weave: 'Flat weave', stripes: 'Stripes', border: 'Bordered', shag: 'Shag' };
export const FLOOR_MATERIALS = { planks: 'Wood planks', tile: 'Tile', carpet: 'Carpet', concrete: 'Concrete' };
export const materialsFor = type => (isFlat(ITEM_DEFS[type].kind) ? RUG_MATERIALS : MATERIALS);

// Colour palettes: [name, hex].
export const FINISH_COLORS = [
  ['White', '#f1efe9'], ['Birch', '#dcc39b'], ['Oak', '#c9a577'], ['Walnut', '#8a5a3a'], ['Espresso', '#4a3528'],
  ['Black', '#2e2c2b'], ['Grey', '#9a9da1'], ['Denim', '#3f5d73'], ['Forest', '#2f4a3c'], ['Olive', '#7d8c6a'],
  ['Rust', '#b4573a'], ['Cognac', '#a86b3c'], ['Mustard', '#d2a43c'], ['Rose', '#c98d9a'], ['Plum', '#5b4a7a'],
];
export const PAINT_COLORS = [
  ['White', '#f8f8f6'], ['Chalk', '#ece9e2'], ['Linen', '#e6ddd0'], ['Oat', '#dccfb9'], ['Blush', '#e3c1b4'],
  ['Sky', '#b9cfdf'], ['Sage', '#9aa98f'], ['Eucalyptus', '#6f8f86'], ['Slate blue', '#5f7896'],
  ['Mustard', '#d2a43c'], ['Clay', '#b8694d'], ['Charcoal', '#3b3f45'],
];
export const FLOOR_COLORS = [
  ['Maple', '#dcc39b'], ['Oak', '#c9a577'], ['Honey', '#a87b4f'], ['Walnut', '#7b5236'], ['Espresso', '#4a3428'],
  ['Cream', '#e9e2d3'], ['Pale grey', '#d8d5cf'], ['Grey', '#a9aaa8'],
];

/** Windows, doors and outlets. Sizes in metres; `sill` is the height of the bottom edge above the floor. */
export const OPENING_DEFAULTS = {
  window: { name: 'Window', width: 48 * INCH, height: 48 * INCH, sill: 36 * INCH },
  door: { name: 'Door', width: 32 * INCH, height: 80 * INCH, sill: 0 },
  outlet: { name: 'Outlet', width: 2.75 * INCH, height: 4.5 * INCH, sill: 12 * INCH },
};

/** Starting room shapes, as corner lists in feet, clockwise from the top left. */
export const ROOM_TEMPLATES = {
  rect: [[0, 0], [14, 0], [14, 12], [0, 12]],
  l: [[0, 0], [18, 0], [18, 11], [11, 11], [11, 16], [0, 16]],
  t: [[0, 0], [18, 0], [18, 8], [12, 8], [12, 15], [6, 15], [6, 8], [0, 8]],
  bay: [[0, 2], [5, 2], [7, 0], [11, 0], [13, 2], [16, 2], [16, 13], [0, 13]],
};
