// Grading-panel primaries (lift/gamma/gain per channel). Here to show that a very
// different vocabulary still fits in one short file.

import { liftGammaGainToCdl } from "./helpers.ts";
import type { Adapter, Control } from "./types.ts";
import { makeParams, type RGB } from "../core/params.ts";

const CHANNELS = ["Master", "Red", "Green", "Blue"] as const;

function wheel(name: "lift" | "gamma" | "gain", label: string, min: number, max: number, def: number): Control[] {
  return CHANNELS.map((ch) => ({ key: `${name}${ch}`, label: `${ch}`, group: label, min, max, step: 0.01, default: def }));
}

export const primaries: Adapter = {
  id: "primaries",
  name: "Lift / Gamma / Gain",
  description: "Grading-panel wheels: lift, gamma and gain per channel, with contrast, pivot and saturation.",
  controls: [
    ...wheel("lift", "Lift", -0.5, 0.5, 0),
    ...wheel("gamma", "Gamma", -0.5, 0.5, 0),
    ...wheel("gain", "Gain", 0, 2, 1),
    { key: "contrast", label: "Contrast", group: "Primaries", min: 0, max: 2, step: 0.01, default: 1 },
    { key: "pivot", label: "Pivot", group: "Primaries", min: 0.1, max: 0.9, step: 0.005, default: 0.5 },
    { key: "saturation", label: "Saturation", group: "Primaries", min: 0, max: 100, step: 1, default: 50 },
  ],

  toParams(v) {
    const slope: RGB = [1, 1, 1];
    const offset: RGB = [0, 0, 0];
    const power: RGB = [1, 1, 1];
    (["Red", "Green", "Blue"] as const).forEach((ch, i) => {
      const cdl = liftGammaGainToCdl(
        v.liftMaster + v[`lift${ch}`],
        v.gammaMaster + v[`gamma${ch}`],
        v.gainMaster * v[`gain${ch}`],
      );
      slope[i] = cdl.slope;
      offset[i] = cdl.offset;
      power[i] = cdl.power;
    });
    return makeParams({
      contrast: v.contrast - 1,
      pivot: v.pivot,
      slope,
      offset,
      power,
      saturation: v.saturation / 50,
    });
  },
};
