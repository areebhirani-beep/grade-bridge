// Unofficial, not affiliated with Flick.
//
// Source: flick.art/docs/effects-and-color (read Oct 22, 2026). The Color tab has
// "Color & Light" with sections Light, Color and Curves; the Effects panel adds a
// Split Tone card. Those names are used verbatim as groups. The docs do not list
// the sliders inside each section, so slider names and ranges here are
// conventional guesses, and the math is ours, not Flick's.
//
// Not representable as a LUT: Chroma Key (needs alpha) and the Blur & Glow,
// Stylize and Distort effects (they read neighbouring pixels).

import { liftGammaGainToCdl, parametricCurve, pct } from "./helpers.ts";
import type { Adapter, Control } from "./types.ts";
import { makeParams } from "../core/params.ts";

const s = (key: string, label: string, group: string, extra: Partial<Control> = {}): Control => ({
  key, label, group, min: -100, max: 100, step: 1, default: 0, ...extra,
});

export const flick: Adapter = {
  id: "flick",
  name: "Flick-style controls",
  description: "Unofficial. Group names follow Flick's docs (Light, Color, Curves, Split Tone); the color math is not Flick's.",
  controls: [
    s("exposure", "Exposure", "Light", { min: -3, max: 3, step: 0.05, unit: "EV" }),
    s("contrast", "Contrast", "Light"),
    s("highlights", "Highlights", "Light"),
    s("shadows", "Shadows", "Light"),
    s("whites", "Whites", "Light"),
    s("blacks", "Blacks", "Light"),

    s("temperature", "Temperature", "Color"),
    s("tint", "Tint", "Color"),
    s("saturation", "Saturation", "Color"),
    s("vibrance", "Vibrance", "Color"),

    s("curveShadows", "Shadows", "Curves"),
    s("curveMidtones", "Midtones", "Curves"),
    s("curveHighlights", "Highlights", "Curves"),
    s("curveRed", "Red", "Curves"),
    s("curveGreen", "Green", "Curves"),
    s("curveBlue", "Blue", "Curves"),
    s("fade", "Fade", "Curves", { min: 0 }),

    s("splitShadowHue", "Shadow hue", "Split Tone", { min: 0, max: 360, default: 210, unit: "°", kind: "hue" }),
    s("splitShadowAmount", "Shadow amount", "Split Tone", { min: 0 }),
    s("splitHighlightHue", "Highlight hue", "Split Tone", { min: 0, max: 360, default: 35, unit: "°", kind: "hue" }),
    s("splitHighlightAmount", "Highlight amount", "Split Tone", { min: 0 }),
    s("splitBalance", "Balance", "Split Tone"),

  ],

  toParams(v) {
    // Blacks moves where black lands, Whites where white lands.
    const lift = 0.1 * pct(v.blacks);
    const gain = 1 + 0.25 * pct(v.whites);
    const { slope, offset, power } = liftGammaGainToCdl(lift, 0, gain);
    const channelMid = (n: number) => parametricCurve([0.5], [pct(n)], 0.12);

    return makeParams({
      exposure: v.exposure,
      contrast: 0.6 * pct(v.contrast),
      highlights: pct(v.highlights),
      shadows: pct(v.shadows),
      slope: [slope, slope, slope],
      offset: [offset, offset, offset],
      power: [power, power, power],

      temperature: pct(v.temperature),
      tint: pct(v.tint),
      saturation: 1 + pct(v.saturation),
      vibrance: pct(v.vibrance),

      curves: {
        master: parametricCurve([0.25, 0.5, 0.75], [pct(v.curveShadows), pct(v.curveMidtones), pct(v.curveHighlights)], 0.15),
        red: channelMid(v.curveRed),
        green: channelMid(v.curveGreen),
        blue: channelMid(v.curveBlue),
      },
      fade: pct(v.fade),

      splitTone: {
        shadowHue: v.splitShadowHue,
        shadowAmount: pct(v.splitShadowAmount),
        highlightHue: v.splitHighlightHue,
        highlightAmount: pct(v.splitHighlightAmount),
        balance: pct(v.splitBalance),
      },
    });
  },
};
