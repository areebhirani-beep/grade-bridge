import type { CurvePoint } from "../core/params.ts";

/** -100..100 to -1..1. */
export const pct = (v: number) => v / 100;

/** Fixed x positions; each slider nudges a point's y. All zeros is the identity line. */
export function parametricCurve(xs: number[], nudges: number[], maxShift: number): CurvePoint[] {
  return [[0, 0], ...xs.map((x, i): CurvePoint => [x, Math.min(1, Math.max(0, x + nudges[i] * maxShift))]), [1, 1]];
}

// (gain * (x + lift * (1 - x))) ^ power  ==  (x * gain*(1 - lift) + gain*lift) ^ power,
// so lift/gamma/gain maps to CDL with no approximation.
export function liftGammaGainToCdl(lift: number, gamma: number, gain: number) {
  // Gamma is kept above -0.9 so the power never blows up.
  return { slope: gain * (1 - lift), offset: gain * lift, power: 1 / (1 + Math.max(gamma, -0.9)) };
}
