// Input and output are display-encoded sRGB values in 0..1, which is what a
// .cube is indexed by in every editor.
//
// Order, and why:
//   1. Exposure + white balance in linear light, where "one stop" is exactly x2.
//   2. Tone (contrast, highlights/shadows, CDL) on display values, where 0.5
//      looks like middle grey, so sliders feel even.
//   3. Color (saturation, vibrance, split tone) after tone, so tints follow the
//      final brightness.
//   4. Curves, black point, fade as the finishing layer.
//   5. Clamp, because a LUT cannot store values outside 0..1.

import { monotoneCurve, isIdentityCurve, type CurveFn } from "./curve.ts";
import type { GradeParams, RGB } from "./params.ts";

/** Rec.709 luma weights. */
export const LUMA: RGB = [0.2126, 0.7152, 0.0722];

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  if (c <= 0) return 0;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const luma = (r: number, g: number, b: number) => LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** HSV(hue, 1, 1). */
export function hueToRgb(hueDeg: number): RGB {
  const h = (((hueDeg % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  if (h < 1) return [1, x, 0];
  if (h < 2) return [x, 1, 0];
  if (h < 3) return [0, 1, x];
  if (h < 4) return [0, x, 1];
  if (h < 5) return [x, 0, 1];
  return [1, 0, x];
}

// The hue minus its own luma, so adding it tints without brightening.
function chromaOf(hueDeg: number): RGB {
  const [r, g, b] = hueToRgb(hueDeg);
  const y = luma(r, g, b);
  return [r - y, g - y, b - y];
}

export function linearGains(p: GradeParams): RGB {
  const r = Math.pow(2, 0.3 * p.temperature);
  const b = Math.pow(2, -0.3 * p.temperature);
  const g = Math.pow(2, -0.25 * p.tint);
  // Normalized so white balance changes hue but not the brightness of a neutral grey.
  const norm = Math.pow(2, p.exposure) / luma(r, g, b);
  return [r * norm, g * norm, b * norm];
}

// Bumps that peak at 1/3 (shadows) and 2/3 (highlights) and leave pure black and
// white in place. 1.25 is the largest gain that keeps the curve monotone after clamping.
function toneBumps(x: number, shadows: number, highlights: number): number {
  const inv = 1 - x;
  return clamp01(x + 1.25 * (shadows * x * inv * inv + highlights * x * x * inv));
}

export type GradeFn = (r: number, g: number, b: number, out: ArrayLike<number> & { [i: number]: number }, at: number) => void;

// Precomputes everything that doesn't depend on the pixel, so a 33^3 build is a
// few ms. Stages at their defaults are skipped, which also makes identity exact.
export function compileGrade(p: GradeParams): GradeFn {
  const useLinear = p.exposure !== 0 || p.temperature !== 0 || p.tint !== 0;
  const gains = linearGains(p);

  const contrastSlope = 1 + p.contrast;
  const useTone = p.contrast !== 0 || p.shadows !== 0 || p.highlights !== 0;

  const { slope, offset, power } = p;
  const useCdl = [0, 1, 2].some((i) => slope[i] !== 1 || offset[i] !== 0 || power[i] !== 1);

  const useSat = p.saturation !== 1 || p.vibrance !== 0;

  const st = p.splitTone;
  const useSplit = st.shadowAmount > 0 || st.highlightAmount > 0;
  const shadowTint = chromaOf(st.shadowHue).map((c) => c * 0.35 * st.shadowAmount);
  const highlightTint = chromaOf(st.highlightHue).map((c) => c * 0.35 * st.highlightAmount);
  const crossover = 0.5 - 0.35 * st.balance;

  const curves: (CurveFn | null)[] = [p.curves.master, p.curves.red, p.curves.green, p.curves.blue].map((pts) =>
    isIdentityCurve(pts) ? null : monotoneCurve(pts),
  );
  const [master, ...channelCurves] = curves;

  const blackPoint = Math.min(p.blackPoint, 0.99);
  const fadeLift = 0.25 * p.fade;

  return (r, g, b, out, at) => {
    const c = [r, g, b];

    if (useLinear) {
      for (let i = 0; i < 3; i++) c[i] = clamp01(linearToSrgb(srgbToLinear(c[i]) * gains[i]));
    }

    if (useTone) {
      for (let i = 0; i < 3; i++) {
        const x = clamp01((c[i] - p.pivot) * contrastSlope + p.pivot);
        c[i] = toneBumps(x, p.shadows, p.highlights);
      }
    }

    // The CDL spec clamps before the power.
    if (useCdl) {
      for (let i = 0; i < 3; i++) {
        const x = clamp01(c[i] * slope[i] + offset[i]);
        c[i] = power[i] === 1 ? x : Math.pow(x, power[i]);
      }
    }

    if (useSat) {
      const y = luma(c[0], c[1], c[2]);
      const colorfulness = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
      const k = p.saturation * (1 + p.vibrance * (1 - colorfulness));
      for (let i = 0; i < 3; i++) c[i] = clamp01(y + (c[i] - y) * k);
    }

    if (useSplit) {
      const y = luma(c[0], c[1], c[2]);
      const wHigh = smoothstep(crossover - 0.5, crossover + 0.5, y);
      const wShadow = 1 - wHigh;
      for (let i = 0; i < 3; i++) c[i] = clamp01(c[i] + shadowTint[i] * wShadow + highlightTint[i] * wHigh);
    }

    if (master) for (let i = 0; i < 3; i++) c[i] = master(clamp01(c[i]));
    for (let i = 0; i < 3; i++) {
      const curve = channelCurves[i];
      if (curve) c[i] = curve(clamp01(c[i]));
    }

    if (blackPoint > 0) for (let i = 0; i < 3; i++) c[i] = clamp01((c[i] - blackPoint) / (1 - blackPoint));
    if (fadeLift > 0) for (let i = 0; i < 3; i++) c[i] = fadeLift + c[i] * (1 - fadeLift);

    out[at] = clamp01(c[0]);
    out[at + 1] = clamp01(c[1]);
    out[at + 2] = clamp01(c[2]);
  };
}

export function applyGrade(rgb: RGB, p: GradeParams): RGB {
  const out: RGB = [0, 0, 0];
  compileGrade(p)(rgb[0], rgb[1], rgb[2], out, 0);
  return out;
}
