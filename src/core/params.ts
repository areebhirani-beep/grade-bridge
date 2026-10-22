/**
 * GradeParams: the one shared language every adapter translates into.
 *
 * An app's sliders (Flick, Lightroom, a colorist's lift/gamma/gain wheels...)
 * are mapped by an adapter into this object. The pipeline only ever sees
 * GradeParams, so the color math is written once and reused everywhere.
 *
 * Every default below is the identity: a grade made of only defaults changes
 * nothing, which the tests check.
 */

export type RGB = [number, number, number];

/** A curve control point, both values in 0..1 (x = input, y = output). */
export type CurvePoint = [number, number];

export interface Curves {
  master: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export interface SplitTone {
  /** Hue in degrees (0 = red, 120 = green, 240 = blue) pushed into the shadows. */
  shadowHue: number;
  /** 0..1, how strongly the shadows are tinted. */
  shadowAmount: number;
  highlightHue: number;
  highlightAmount: number;
  /** -1..1. Negative favors the shadow tint, positive the highlight tint. */
  balance: number;
}

export interface Duotone {
  /** Hue (degrees) that the darkest tones are mapped to. */
  darkHue: number;
  /** Hue (degrees) that the brightest tones are mapped to. */
  lightHue: number;
  /** 0..1 mix between the graded image and the two-color version. */
  amount: number;
}

export interface GradeParams {
  // --- Linear-light stage -------------------------------------------------
  /** Exposure in photographic stops. +1 doubles the light. */
  exposure: number;
  /** -1..1. Positive is warmer (more red, less blue). */
  temperature: number;
  /** -1..1. Positive is more magenta, negative more green. */
  tint: number;

  // --- Tone stage (on display-encoded values) -----------------------------
  /** -1..1. Slope around `pivot`: 0.5 means 1.5x the contrast. */
  contrast: number;
  /** The tone (0..1) that contrast rotates around and leaves unchanged. */
  pivot: number;
  /** -1..1. Brightens (+) or recovers (-) the bright end only. */
  highlights: number;
  /** -1..1. Opens up (+) or deepens (-) the dark end only. */
  shadows: number;
  /**
   * ASC CDL primaries, per channel: out = (in * slope + offset) ^ power.
   * This is the industry's interchange format for primary corrections, and
   * lift/gamma/gain converts into it exactly (see adapters/primaries.ts).
   */
  slope: RGB;
  offset: RGB;
  power: RGB;

  // --- Color stage --------------------------------------------------------
  /** Multiplier on saturation. 1 = unchanged, 0 = black and white. */
  saturation: number;
  /** -1..1. Saturation boost that mostly skips colors that are already saturated. */
  vibrance: number;
  splitTone: SplitTone;
  duotone: Duotone;

  // --- Finishing ----------------------------------------------------------
  curves: Curves;
  /** 0..1. Crushes everything below this level to black. */
  blackPoint: number;
  /** 0..1. Lifts the blacks toward grey for a faded, matte look. */
  fade: number;
}

export const IDENTITY_CURVE: CurvePoint[] = [
  [0, 0],
  [1, 1],
];

export function defaultParams(): GradeParams {
  return {
    exposure: 0,
    temperature: 0,
    tint: 0,
    contrast: 0,
    pivot: 0.5,
    highlights: 0,
    shadows: 0,
    slope: [1, 1, 1],
    offset: [0, 0, 0],
    power: [1, 1, 1],
    saturation: 1,
    vibrance: 0,
    splitTone: { shadowHue: 220, shadowAmount: 0, highlightHue: 40, highlightAmount: 0, balance: 0 },
    duotone: { darkHue: 230, lightHue: 45, amount: 0 },
    curves: {
      master: IDENTITY_CURVE.map((p) => [...p] as CurvePoint),
      red: IDENTITY_CURVE.map((p) => [...p] as CurvePoint),
      green: IDENTITY_CURVE.map((p) => [...p] as CurvePoint),
      blue: IDENTITY_CURVE.map((p) => [...p] as CurvePoint),
    },
    blackPoint: 0,
    fade: 0,
  };
}

/**
 * Start from the identity and override only what you pass.
 * Nested objects (splitTone, duotone, curves) are merged one level deep.
 */
export function makeParams(overrides: Partial<GradeParams> = {}): GradeParams {
  const base = defaultParams();
  return {
    ...base,
    ...overrides,
    splitTone: { ...base.splitTone, ...overrides.splitTone },
    duotone: { ...base.duotone, ...overrides.duotone },
    curves: { ...base.curves, ...overrides.curves },
  };
}
