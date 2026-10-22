import { describe, expect, it } from "vitest";
import { flick } from "../src/adapters/flick.ts";
import { defaultValues } from "../src/adapters/types.ts";
import type { GradeParams } from "../src/core/params.ts";

/** Grade params produced when only one Flick control is moved. */
function withOnly(key: string, value: number): GradeParams {
  return flick.toParams({ ...defaultValues(flick), [key]: value });
}

/** Paths into GradeParams that differ from the adapter's all-defaults result, e.g. "contrast" or "curves.master". */
function changedPaths(p: GradeParams): string[] {
  const base = flick.toParams(defaultValues(flick)) as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    const b = base[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (JSON.stringify(v2) !== JSON.stringify((b as Record<string, unknown>)[k2])) out.push(`${k}.${k2}`);
      }
    } else if (JSON.stringify(v) !== JSON.stringify(b)) out.push(k);
  }
  return out.sort();
}

describe("Flick-style adapter", () => {
  it("uses Flick's documented section names as groups", () => {
    const groups = [...new Set(flick.controls.map((c) => c.group))];
    expect(groups).toEqual(["Light", "Color", "Curves", "Split Tone"]);
  });

  // [control, test value, params it should touch, check on the result]
  const table: [string, number, string[], (p: GradeParams) => void][] = [
    ["exposure", 1.5, ["exposure"], (p) => expect(p.exposure).toBe(1.5)],
    ["contrast", 50, ["contrast"], (p) => expect(p.contrast).toBeCloseTo(0.3)],
    ["highlights", -40, ["highlights"], (p) => expect(p.highlights).toBeCloseTo(-0.4)],
    ["shadows", 60, ["shadows"], (p) => expect(p.shadows).toBeCloseTo(0.6)],
    ["whites", 100, ["slope"], (p) => expect(p.slope).toEqual([1.25, 1.25, 1.25])],
    ["blacks", 100, ["offset", "slope"], (p) => {
      // Black is lifted to 0.1 while white stays at 1.
      expect(p.offset[0]).toBeCloseTo(0.1);
      expect(p.slope[0] + p.offset[0]).toBeCloseTo(1);
    }],
    ["temperature", 30, ["temperature"], (p) => expect(p.temperature).toBeCloseTo(0.3)],
    ["tint", -20, ["tint"], (p) => expect(p.tint).toBeCloseTo(-0.2)],
    ["saturation", -100, ["saturation"], (p) => expect(p.saturation).toBe(0)],
    ["vibrance", 25, ["vibrance"], (p) => expect(p.vibrance).toBeCloseTo(0.25)],
    ["curveShadows", 100, ["curves.master"], (p) => expect(p.curves.master).toContainEqual([0.25, 0.4])],
    ["curveMidtones", -100, ["curves.master"], (p) => expect(p.curves.master).toContainEqual([0.5, 0.35])],
    ["curveHighlights", 100, ["curves.master"], (p) => expect(p.curves.master[3][1]).toBeCloseTo(0.9)],
    ["curveRed", 100, ["curves.red"], (p) => expect(p.curves.red[1][1]).toBeCloseTo(0.62)],
    ["curveGreen", -100, ["curves.green"], (p) => expect(p.curves.green[1][1]).toBeCloseTo(0.38)],
    ["curveBlue", 50, ["curves.blue"], (p) => expect(p.curves.blue[1][1]).toBeCloseTo(0.56)],
    ["fade", 40, ["fade"], (p) => expect(p.fade).toBeCloseTo(0.4)],
    ["splitShadowHue", 180, ["splitTone.shadowHue"], (p) => expect(p.splitTone.shadowHue).toBe(180)],
    ["splitShadowAmount", 70, ["splitTone.shadowAmount"], (p) => expect(p.splitTone.shadowAmount).toBeCloseTo(0.7)],
    ["splitHighlightHue", 20, ["splitTone.highlightHue"], (p) => expect(p.splitTone.highlightHue).toBe(20)],
    ["splitHighlightAmount", 30, ["splitTone.highlightAmount"], (p) => expect(p.splitTone.highlightAmount).toBeCloseTo(0.3)],
    ["splitBalance", -50, ["splitTone.balance"], (p) => expect(p.splitTone.balance).toBeCloseTo(-0.5)],
  ];

  it("the table covers every control", () => {
    expect(table.map((row) => row[0]).sort()).toEqual(flick.controls.map((c) => c.key).sort());
  });

  it.each(table)("%s = %d maps to %j only", (key, value, touches, check) => {
    const p = withOnly(key, value);
    check(p);
    expect(changedPaths(p)).toEqual(touches.sort());
  });
});
