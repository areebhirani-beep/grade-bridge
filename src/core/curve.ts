// Monotone cubic spline (Fritsch-Carlson, 1980). An ordinary smooth spline can
// overshoot past its neighbouring points, which in a grade shows up as tones
// flipping order. Limiting the tangents keeps each segment between its endpoints.

import type { CurvePoint } from "./params.ts";

export type CurveFn = (x: number) => number;

export function isIdentityCurve(points: CurvePoint[]): boolean {
  return points.every(([x, y]) => Math.abs(x - y) < 1e-9);
}

export function monotoneCurve(input: CurvePoint[]): CurveFn {
  // Sort by x and drop duplicate x values (the last one wins).
  const sorted = [...input].sort((a, b) => a[0] - b[0]);
  const pts: CurvePoint[] = [];
  for (const p of sorted) {
    if (pts.length && Math.abs(pts[pts.length - 1][0] - p[0]) < 1e-9) pts[pts.length - 1] = p;
    else pts.push(p);
  }
  if (pts.length === 0) return (x) => x;
  if (pts.length === 1) return () => pts[0][1];

  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);

  // 1. Secant slope of every segment.
  const secant: number[] = [];
  for (let k = 0; k < n - 1; k++) secant.push((ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]));

  // 2. Initial tangents: average of neighboring secants, zero at a local peak or valley.
  const m: number[] = new Array(n);
  m[0] = secant[0];
  m[n - 1] = secant[n - 2];
  for (let k = 1; k < n - 1; k++) {
    m[k] = secant[k - 1] * secant[k] <= 0 ? 0 : (secant[k - 1] + secant[k]) / 2;
  }

  // 3. Fritsch-Carlson limiter: keep (alpha, beta) inside the circle of radius 3.
  for (let k = 0; k < n - 1; k++) {
    if (secant[k] === 0) {
      m[k] = 0;
      m[k + 1] = 0;
      continue;
    }
    const a = m[k] / secant[k];
    const b = m[k + 1] / secant[k];
    if (a < 0) m[k] = 0;
    if (b < 0) m[k + 1] = 0;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[k] = t * a * secant[k];
      m[k + 1] = t * b * secant[k];
    }
  }

  // 4. Evaluate as a cubic Hermite segment. Outside the points, hold the end value.
  return (x: number): number => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo] +
      (t3 - 2 * t2 + t) * h * m[lo] +
      (-2 * t3 + 3 * t2) * ys[hi] +
      (t3 - t2) * h * m[hi]
    );
  };
}
