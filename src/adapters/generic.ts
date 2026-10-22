// Lightroom-style names, which most photo and video apps copy. A starting point
// for an app with no adapter of its own.

import { liftGammaGainToCdl, parametricCurve, pct } from "./helpers.ts";
import type { Adapter, Control } from "./types.ts";
import { makeParams } from "../core/params.ts";

const s = (key: string, label: string, group: string, extra: Partial<Control> = {}): Control => ({
  key, label, group, min: -100, max: 100, step: 1, default: 0, ...extra,
});

export const generic: Adapter = {
  id: "generic",
  name: "Photo-editor controls",
  description: "The Lightroom-style names most photo and video apps share.",
  controls: [
    s("temp", "Temp", "White Balance"),
    s("tint", "Tint", "White Balance"),

    s("exposure", "Exposure", "Tone", { min: -5, max: 5, step: 0.05, unit: "EV" }),
    s("contrast", "Contrast", "Tone"),
    s("highlights", "Highlights", "Tone"),
    s("shadows", "Shadows", "Tone"),
    s("whites", "Whites", "Tone"),
    s("blacks", "Blacks", "Tone"),

    s("vibrance", "Vibrance", "Presence"),
    s("saturation", "Saturation", "Presence"),

    s("curveHighlights", "Highlights", "Tone Curve"),
    s("curveLights", "Lights", "Tone Curve"),
    s("curveDarks", "Darks", "Tone Curve"),
    s("curveShadows", "Shadows", "Tone Curve"),

    s("gradeShadowHue", "Shadows hue", "Color Grading", { min: 0, max: 360, default: 210, unit: "°", kind: "hue" }),
    s("gradeShadowSat", "Shadows sat", "Color Grading", { min: 0 }),
    s("gradeHighlightHue", "Highlights hue", "Color Grading", { min: 0, max: 360, default: 40, unit: "°", kind: "hue" }),
    s("gradeHighlightSat", "Highlights sat", "Color Grading", { min: 0 }),
    s("gradeBalance", "Balance", "Color Grading"),
  ],

  toParams(v) {
    const { slope, offset, power } = liftGammaGainToCdl(0.1 * pct(v.blacks), 0, 1 + 0.25 * pct(v.whites));
    return makeParams({
      temperature: pct(v.temp),
      tint: pct(v.tint),
      exposure: v.exposure,
      contrast: 0.6 * pct(v.contrast),
      highlights: pct(v.highlights),
      shadows: pct(v.shadows),
      slope: [slope, slope, slope],
      offset: [offset, offset, offset],
      power: [power, power, power],
      vibrance: pct(v.vibrance),
      saturation: 1 + pct(v.saturation),
      curves: {
        master: parametricCurve(
          [0.125, 0.375, 0.625, 0.875],
          [pct(v.curveShadows), pct(v.curveDarks), pct(v.curveLights), pct(v.curveHighlights)],
          0.12,
        ),
        red: [[0, 0], [1, 1]],
        green: [[0, 0], [1, 1]],
        blue: [[0, 0], [1, 1]],
      },
      splitTone: {
        shadowHue: v.gradeShadowHue,
        shadowAmount: pct(v.gradeShadowSat),
        highlightHue: v.gradeHighlightHue,
        highlightAmount: pct(v.gradeHighlightSat),
        balance: pct(v.gradeBalance),
      },
    });
  },
};
