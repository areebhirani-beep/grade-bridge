/**
 * The grade itself: one pure function from an input color to an output color.
 *
 * Input and output are display (sRGB-encoded) values in 0..1, which is what
 * a .cube LUT is indexed by in every editor that loads it.
 *
 * Order of operations, and why:
 *   1. Exposure + white balance in LINEAR light. Light adds and multiplies
 *      physically in linear, so "one stop brighter" is exactly x2 there.
 *   2. Tone (contrast, highlights/shadows, CDL primaries) on display values,
 *      where 0.5 looks like a middle grey, so sliders feel even.
 *   3. Color (saturation, vibrance, split tone, duotone) after tone, so the
 *      tint follows the final brightness of each pixel.
 *   4. Curves, black point and fade last, as the finishing look.
 *   5. Clamp to 0..1, because a LUT cannot output outside that range.
 */

import { monotoneCurve, isIdentityCurve, type CurveFn } from "./curve.ts";
import type { GradeParams, RGB } from "./params.ts";

/** Rec.709 luma weights: how bright each channel looks to the eye. */
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

/** A fully saturated color for a hue in degrees (HSV with s = v = 1). */
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

/** The "color part" of a hue with its brightness removed, so adding it tints without brightening. */
function chromaOf(hueDeg: number): RGB {
  const [r, g, b] = hueToRgb(hueDeg);
  const y = luma(r, g, b);
  return [r - y, g - y, b - y];
}

/** Multiplies per channel, in linear light: exposure (2^stops) times white balance. */
export function linearGains(p: GradeParams): RGB {
  const r = Math.pow(2, 0.3 * p.temperature);
  const b = Math.pow(2, -0.3 * p.temperature);
  const g = Math.pow(2, -0.25 * p.tint);
  // Normalize so a neutral grey keeps its brightness: white balance shifts hue, exposure shifts level.
  const norm = Math.pow(2, p.exposure) / luma(r, g, b);
  return [r * norm, g * norm, b * norm];
}

/**
 * Highlights/shadows as gentle per-channel bumps.
 * shadows:    x + s * 1.25 * x(1-x)^2   (peaks at x = 1/3)
 * highlights: x + h * 1.25 * x^2(1-x)   (peaks at x = 2/3)
 * Both leave pure black and pure white where they are.
 */
function toneBumps(x: number, shadows: number, highlights: number): number {
  const inv = 1 - x;
  return clamp01(x + 1.25 * (shadows * x * inv * inv + highlights * x * x * inv));
}

export type GradeFn = (r: number, g: number, b: number, out: ArrayLike<number> & { [i: number]: number }, at: number) => void;

/**
 * Pre-compute everything that does not depend on the pixel (curve tangents,
 * channel gains, tint colors) and return a fast per-pixel function.
 * Stages whose controls are at their defaults are skipped entirely.
 */
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

  const duo = p.duotone;
  const useDuo = duo.amount > 0;
  const duoDark = hueToRgb(duo.darkHue).map((c) => 0.06 + 0.22 * c);
  const duoLight = hueToRgb(duo.lightHue).map((c) => 0.72 + 0.28 * c);

  const curves: (CurveFn | null)[] = [p.curves.master, p.curves.red, p.curves.green, p.curves.blue].map((pts) =>
    isIdentityCurve(pts) ? null : monotoneCurve(pts),
  );
  const [master, ...channelCurves] = curves;

  const blackPoint = Math.min(p.blackPoint, 0.99);
  const fadeLift = 0.25 * p.fade;

  return (r, g, b, out, at) => {
    const c = [r, g, b];

    // 1. Exposure + white balance, in linear light.
    if (useLinear) {
      for (let i = 0; i < 3; i++) c[i] = clamp01(linearToSrgb(srgbToLinear(c[i]) * gains[i]));
    }

    // 2. Tone: contrast around the pivot, then highlights and shadows.
    if (useTone) {
      for (let i = 0; i < 3; i++) {
        const x = clamp01((c[i] - p.pivot) * contrastSlope + p.pivot);
        c[i] = toneBumps(x, p.shadows, p.highlights);
      }
    }

    // 2b. ASC CDL primaries: (x * slope + offset) ^ power, clamped as the CDL spec does.
    if (useCdl) {
      for (let i = 0; i < 3; i++) {
        const x = clamp01(c[i] * slope[i] + offset[i]);
        c[i] = power[i] === 1 ? x : Math.pow(x, power[i]);
      }
    }

    // 3. Saturation and vibrance, around Rec.709 luma so brightness is kept.
    if (useSat) {
      const y = luma(c[0], c[1], c[2]);
      const colorfulness = Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
      // Vibrance is strongest on dull colors and fades to nothing on saturated ones.
      const k = p.saturation * (1 + p.vibrance * (1 - colorfulness));
      for (let i = 0; i < 3; i++) c[i] = clamp01(y + (c[i] - y) * k);
    }

    // 3b. Split tone: one hue into the shadows, another into the highlights.
    if (useSplit) {
      const y = luma(c[0], c[1], c[2]);
      const wHigh = smoothstep(crossover - 0.5, crossover + 0.5, y);
      const wShadow = 1 - wHigh;
      for (let i = 0; i < 3; i++) c[i] = clamp01(c[i] + shadowTint[i] * wShadow + highlightTint[i] * wHigh);
    }

    // 3c. Duotone: map brightness onto a two-color ramp, then mix it in.
    if (useDuo) {
      const y = smoothstep(0, 1, luma(c[0], c[1], c[2]));
      for (let i = 0; i < 3; i++) {
        const ramp = duoDark[i] + (duoLight[i] - duoDark[i]) * y;
        c[i] = c[i] + (ramp - c[i]) * duo.amount;
      }
    }

    // 4. Curves: master first, then each channel.
    if (master) for (let i = 0; i < 3; i++) c[i] = master(clamp01(c[i]));
    for (let i = 0; i < 3; i++) {
      const curve = channelCurves[i];
      if (curve) c[i] = curve(clamp01(c[i]));
    }

    // 4b. Black point (crush) then fade (lift the blacks toward grey).
    if (blackPoint > 0) for (let i = 0; i < 3; i++) c[i] = clamp01((c[i] - blackPoint) / (1 - blackPoint));
    if (fadeLift > 0) for (let i = 0; i < 3; i++) c[i] = fadeLift + c[i] * (1 - fadeLift);

    // 5. Clamp: a LUT can only store 0..1.
    out[at] = clamp01(c[0]);
    out[at + 1] = clamp01(c[1]);
    out[at + 2] = clamp01(c[2]);
  };
}

/** Grade a single color. Pure: same input, same output, no side effects. */
export function applyGrade(rgb: RGB, p: GradeParams): RGB {
  const out: RGB = [0, 0, 0];
  compileGrade(p)(rgb[0], rgb[1], rgb[2], out, 0);
  return out;
}
