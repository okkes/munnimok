/** #168 r3 (user): monotone cubic interpolation (Fritsch–Carlson).
 *  The Catmull-Rom smoothing overshot — a drop into a flat stretch
 *  dipped below the data ("looked negative for a bit"). Tangents are
 *  flattened at local extrema and across equal neighbours, then clamped
 *  to the Fritsch–Carlson region, so every segment stays inside its
 *  endpoints' range: equal values draw dead flat, monotone runs never
 *  over/undershoot. */

export interface ChartPt {
  x: number;
  y: number;
}

const coords = (x: number, y: number) => `${x.toFixed(1)},${y.toFixed(1)}`;

/** secant slope of each consecutive pair */
function secants(pts: readonly ChartPt[]): number[] {
  const d: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    d.push(dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx);
  }
  return d;
}

/** per-point dy/dx tangents (exported for the unit tests) */
export function monotoneTangents(pts: readonly ChartPt[]): number[] {
  if (pts.length < 2) return pts.map(() => 0);
  const d = secants(pts);
  const m: number[] = [d[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    // a sign change (or a flat side) is a local extremum — flatten it
    m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  }
  m.push(d.at(-1)!);
  for (let i = 0; i + 1 < pts.length; i++) {
    if (d[i] === 0) {
      // a flat segment keeps BOTH endpoint tangents at zero
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    // α²+β² ≤ 9 (the FC circle) keeps the Hermite segment monotone
    const alpha = m[i] / d[i];
    const beta = m[i + 1] / d[i];
    const size = Math.hypot(alpha, beta);
    if (size > 3) {
      m[i] = (3 / size) * alpha * d[i];
      m[i + 1] = (3 / size) * beta * d[i];
    }
  }
  return m;
}

/**
 * The curve's point at a fractional index `t` (0 … n−1): the same Hermite
 * segment monotonePath draws there, so a marker moved along `t` rides on
 * the stroke (#500) instead of cutting across it.
 */
export function monotonePointAt(pts: readonly ChartPt[], t: number): ChartPt {
  if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 };
  const at = Math.min(pts.length - 1, Math.max(0, t));
  const i = Math.min(pts.length - 2, Math.floor(at));
  const u = at - i;
  const p1 = pts[i];
  const p2 = pts[i + 1];
  // on a data point exactly: no float drift between the marker and the dot it covers
  if (u === 0) return p1;
  if (u === 1) return p2;
  const m = monotoneTangents(pts);
  const dx = p2.x - p1.x;
  const u2 = u * u;
  const u3 = u2 * u;
  const y = (2 * u3 - 3 * u2 + 1) * p1.y + (u3 - 2 * u2 + u) * dx * m[i] + (3 * u2 - 2 * u3) * p2.y + (u3 - u2) * dx * m[i + 1];
  return { x: p1.x + u * dx, y };
}

/** SVG path — the Hermite segments emitted as cubic beziers */
export function monotonePath(pts: readonly ChartPt[]): string {
  if (pts.length < 2) return '';
  const m = monotoneTangents(pts);
  let d = `M${coords(pts[0].x, pts[0].y)}`;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const dx = (p2.x - p1.x) / 3;
    d += ` C${coords(p1.x + dx, p1.y + m[i] * dx)} ${coords(p2.x - dx, p2.y - m[i + 1] * dx)} ${coords(p2.x, p2.y)}`;
  }
  return d;
}
