// Length parsing and formatting.
// Everything inside the app is stored in metres; these helpers convert at the edges.

export const INCH = 0.0254;
export const FOOT = 0.3048;

/** Format a length in metres for display, e.g. `6' 2"` or `1.88 m`. */
export function formatLength(meters, units) {
  if (units === 'metric') {
    return meters >= 1 ? `${+meters.toFixed(2)} m` : `${+(meters * 100).toFixed(1)} cm`;
  }
  const halfInches = Math.round((meters / INCH) * 2) / 2; // nearest half inch
  const feet = Math.floor(halfInches / 12);
  const inches = +(halfInches - feet * 12).toFixed(1);
  if (!feet) return `${inches}"`;
  return inches ? `${feet}' ${inches}"` : `${feet}'`;
}

/**
 * Parse what someone typed into a length field. Returns metres, or null if it can't be read.
 * Accepts: 6' 2"   6'   74"   6 2 (feet inches, imperial only)   1.8m   180cm   74in   6ft
 * A plain number means inches in imperial mode and centimetres in metric mode.
 */
export function parseLength(text, units) {
  const s = String(text).trim().toLowerCase()
    .replace(/[′’‘]/g, "'")
    .replace(/[″”“]|''/g, '"');
  const NUM = '(\\d+(?:\\.\\d+)?)';
  let m;
  if ((m = s.match(new RegExp(`^${NUM}\\s*(mm|cm|m|in|ft)$`)))) {
    return +m[1] * { mm: 0.001, cm: 0.01, m: 1, in: INCH, ft: FOOT }[m[2]];
  }
  if ((m = s.match(new RegExp(`^${NUM}\\s*'\\s*(?:${NUM}\\s*"?)?$`)))) {
    return +m[1] * FOOT + (m[2] ? +m[2] * INCH : 0);
  }
  if ((m = s.match(new RegExp(`^${NUM}\\s*"$`)))) return +m[1] * INCH;
  if (units !== 'metric' && (m = s.match(new RegExp(`^${NUM}\\s+${NUM}$`)))) {
    return +m[1] * FOOT + +m[2] * INCH;
  }
  if ((m = s.match(new RegExp(`^${NUM}$`)))) return +m[1] * (units === 'metric' ? 0.01 : INCH);
  return null;
}

/** Format an area in square metres, e.g. `253 sq ft` or `23.5 m²`. */
export function formatArea(squareMeters, units) {
  return units === 'metric'
    ? `${squareMeters.toFixed(1)} m²`
    : `${Math.round(squareMeters / (FOOT * FOOT))} sq ft`;
}
