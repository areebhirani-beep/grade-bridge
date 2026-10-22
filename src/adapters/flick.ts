/**
 * "Flick-style controls": an UNOFFICIAL adapter, not affiliated with Flick.
 *
 * Source: flick.art/docs/effects-and-color (read Oct 2026). A clip's Color tab
 * holds "Color & Light" with three sections, Light, Color and Curves, and the
 * Effects panel's Color group adds Split Tone and Duotone cards. Those group
 * names are used verbatim below. The docs do not list the individual sliders
 * inside each section, so the slider names here are the conventional ones
 * and are the first thing to confirm with the Flick team.
 *
 * Not carried, because a LUT cannot carry them: Chroma Key (needs transparency)
 * and every Blur & Glow, Stylize and Distort effect (they look at neighbouring
 * pixels or time, and a LUT only sees one pixel's color).
 */

import { liftGammaGainToCdl, parametricCurve, pct } from "./helpers.ts";
import type { Adapter, Control } from "./types.ts";
import { makeParams } from "../core/params.ts";

const s = (key: string, label: string, group: string, extra: Partial<Control> = {}): Control => ({
  key, label, group, min: -100, max: 100, step: 1, default: 0, ...extra,
});

export const flick: Adapter = {
  id: "flick",
  name: "Flick-style controls",
  description: "Color & Light (Light, Color, Curves) plus Split Tone and Duotone, as named in Flick's docs. Unofficial.",
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

    s("duotoneDarkHue", "Dark hue", "Duotone", { min: 0, max: 360, default: 230, unit: "°", kind: "hue" }),
    s("duotoneLightHue", "Light hue", "Duotone", { min: 0, max: 360, default: 45, unit: "°", kind: "hue" }),
    s("duotoneAmount", "Amount", "Duotone", { min: 0 }),
  ],

  toParams(v) {
    // Whites and Blacks pin the two ends of the range: black goes to `lift`, white to `gain`.
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
      duotone: { darkHue: v.duotoneDarkHue, lightHue: v.duotoneLightHue, amount: pct(v.duotoneAmount) },
    });
  },
};
