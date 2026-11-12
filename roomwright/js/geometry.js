// Polygon, wall and rectangle maths. Pure functions, no app state.
// Coordinates are plan coordinates in metres: x to the right, y down the page.

/** Walls are drawn this thick, outside the room polygon, so wall lengths are clear interior sizes. */
export const WALL_THICKNESS = 0.12;

export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Signed area (shoelace). Positive when the corners run clockwise on screen. */
export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Distance from a point to segment a-b, plus `t`: how far along the segment (0..1) the nearest point is. */
export function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared ? ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  return { distance: Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy), t };
}

/** True when segments a-b and c-d properly cross (touching at an end does not count). */
export function segmentsCross(a, b, c, d) {
  const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const eps = 1e-9;
  return side(a, b, c) * side(a, b, d) < -eps && side(c, d, a) * side(c, d, b) < -eps;
}

/** A simple polygon has no walls crossing each other. */
export function isSimplePolygon(points) {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // neighbours share a corner
      if (segmentsCross(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return false;
    }
  }
  return true;
}

/**
 * Describe each wall of a room. Wall i runs from corner i to corner i+1 and takes
 * the id of its starting corner.
 *   a, b        start and end corners
 *   length      in metres
 *   ux, uy      unit vector along the wall
 *   nx, ny      unit normal pointing into the room
 *   inwardSign  +1 or -1: which side of the wall's local y axis is the room interior
 */
export function wallsOf(corners) {
  const inwardSign = polygonArea(corners) > 0 ? 1 : -1;
  return corners.map((a, index) => {
    const b = corners[(index + 1) % corners.length];
    const length = distance(a, b) || 1e-6;
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    return { id: a.id, index, a, b, length, ux, uy, nx: -uy * inwardSign, ny: ux * inwardSign, inwardSign };
  });
}

/**
 * The four corners of a placed item (a rotated rectangle), in plan coordinates.
 * `shrink` pulls each edge inward, which gives overlap tests a little tolerance.
 * An item's local axes: x across its width, y toward its front. Rotation is in degrees.
 */
export function itemCorners(item, shrink = 0) {
  const angle = (item.rot * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const halfW = Math.max(0.001, item.w / 2 - shrink);
  const halfD = Math.max(0.001, item.d / 2 - shrink);
  return [[-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD]]
    .map(([x, y]) => ({ x: item.x + x * cos - y * sin, y: item.y + x * sin + y * cos }));
}

/**
 * The rectangles that make up an item's footprint, each shaped like an item ({ x, y, rot, w, d }).
 * Most items are a single rectangle. An L-shaped sectional (an item with a `seat` depth) is two:
 * the main run along its back, and the return that runs forward down one side. `side` says which
 * side the return is on, as you face the front: 'right' is the item's local +x.
 */
export function itemParts(item) {
  if (!(item.seat > 0)) return [item];
  const { w, d } = item;
  const s = Math.min(item.seat, w, d);
  const k = item.side === 'left' ? -1 : 1;
  const angle = (item.rot * Math.PI) / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const place = (cx, cy, pw, pd) => ({ x: item.x + cx * cos - cy * sin, y: item.y + cx * sin + cy * cos, rot: item.rot, w: pw, d: pd });
  return [
    place(0, -d / 2 + s / 2, w, s),                         // main run, along the back
    place(k * (w / 2 - s / 2), s / 2, s, Math.max(0.001, d - s)), // the return
  ];
}

/** Corners of every rectangle in an item's footprint: a list of corner lists (see itemParts). */
export const footprintQuads = (item, shrink = 0) => itemParts(item).map(part => itemCorners(part, shrink));

/** Separating-axis test for two convex quads given as corner lists. */
export function rectsOverlap(cornersA, cornersB) {
  for (const quad of [cornersA, cornersB]) {
    for (let i = 0; i < 4; i++) {
      const p = quad[i];
      const q = quad[(i + 1) % 4];
      const nx = q.y - p.y;
      const ny = p.x - q.x;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const v of cornersA) { const d = v.x * nx + v.y * ny; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const v of cornersB) { const d = v.x * nx + v.y * ny; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      if (maxA <= minB || maxB <= minA) return false;
    }
  }
  return true;
}

/** Is a plan point inside an item's footprint (its L shape, for a sectional)? `pad` grows it, for easier clicking. */
export function pointInItem(point, item, pad = 0) {
  return itemParts(item).some(part => pointInRect(point, part, pad));
}

function pointInRect(point, item, pad) {
  const angle = (-item.rot * Math.PI) / 180;
  const dx = point.x - item.x;
  const dy = point.y - item.y;
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
  const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(localX) <= item.w / 2 + pad && Math.abs(localY) <= item.d / 2 + pad;
}
