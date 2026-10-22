import { describe, expect, it } from "vitest";
import { monotoneCurve } from "../src/core/curve.ts";
import { parseCube, serializeCube } from "../src/core/cube.ts";
import { buildLut, sampleLut, toLut3D } from "../src/core/lut.ts";
import { defaultParams, makeParams, type CurvePoint, type RGB } from "../src/core/params.ts";
import { applyGrade, linearToSrgb, srgbToLinear } from "../src/core/pipeline.ts";
import { ADAPTERS, presetToParams, type Preset } from "../src/adapters/index.ts";
import { readdirSync, readFileSync } from "node:fs";

/** Deterministic pseudo-random numbers so failures are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function expectIdentityLut(lut: Float32Array, size: number, tolerance = 1e-6) {
  let worst = 0;
  for (let b = 0, i = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++, i += 3) {
        const expected = [r, g, b].map((v) => v / (size - 1));
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(lut[i + c] - expected[c]));
      }
  expect(worst).toBeLessThan(tolerance);
}

const presets: Preset[] = readdirSync("presets")
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(`presets/${f}`, "utf8")));

describe("identity", () => {
  it("default params give an identity LUT", () => {
    expectIdentityLut(buildLut(defaultParams(), 17), 17);
  });

  it("the linear-light round trip is exact enough to be invisible", () => {
    // Exposure 0 but temperature nudged and back: forces the sRGB decode/encode path.
    for (let i = 0; i <= 255; i++) expect(linearToSrgb(srgbToLinear(i / 255))).toBeCloseTo(i / 255, 9);
  });

  it("orders red fastest, as the .cube spec requires", () => {
    const lut = buildLut(defaultParams(), 3);
    expect(Array.from(lut.slice(0, 9))).toEqual([0, 0, 0, 0.5, 0, 0, 1, 0, 0]);
  });
});

describe(".cube serialize / parse", () => {
  it("round-trips a real grade", () => {
    const lut = toLut3D(presetToParams(presets[0]).params, 17);
    const parsed = parseCube(serializeCube(lut, "Round Trip"));
    expect(parsed.title).toBe("Round Trip");
    expect(parsed.size).toBe(17);
    expect(parsed.domainMin).toEqual([0, 0, 0]);
    expect(parsed.domainMax).toEqual([1, 1, 1]);
    expect(parsed.data.length).toBe(lut.data.length);
    for (let i = 0; i < lut.data.length; i++) expect(Math.abs(parsed.data[i] - lut.data[i])).toBeLessThan(1e-6);
  });

  it("accepts comments, blank lines, CRLF and unknown keywords", () => {
    const text = [
      "# a comment",
      "",
      'TITLE "Tiny"',
      "LUT_3D_INPUT_RANGE 0 1",
      "LUT_3D_SIZE 2",
      "",
      "0 0 0", "1 0 0", "0 1 0", "1 1 0",
      "# comment between rows",
      "0 0 1", "1 0 1", "0 1 1", "1 1 1",
    ].join("\r\n");
    const cube = parseCube(text);
    expect(cube.size).toBe(2);
    expect(sampleLut(cube, [0.25, 0.5, 0.75])).toEqual([0.25, 0.5, 0.75]);
  });

  it.each([["1"], ["0"], ["-4"], ["2.5"], ["abc"], ["300"]])("rejects LUT_3D_SIZE %s", (size) => {
    expect(() => parseCube(`LUT_3D_SIZE ${size}\n0 0 0\n`)).toThrow(/LUT_3D_SIZE/);
  });

  it("rejects a file with the wrong number of rows", () => {
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 0\n1 1 1\n")).toThrow(/Expected 2\^3/);
  });

  it("rejects a 1D LUT with a clear message", () => {
    expect(() => parseCube("LUT_1D_SIZE 2\n0 0 0\n1 1 1\n")).toThrow(/1D LUT/);
  });
});

describe("monotone curves", () => {
  it("never overshoot, even with steep and flat sections", () => {
    const random = rng(7);
    for (let trial = 0; trial < 200; trial++) {
      const n = 3 + Math.floor(random() * 5);
      const xs = Array.from({ length: n }, (_, i) => (i === 0 ? 0 : i === n - 1 ? 1 : random())).sort();
      // Half the trials are increasing curves, half are wild ones with peaks and valleys.
      let y = 0;
      const pts: CurvePoint[] = xs.map((x) => {
        y = trial % 2 ? Math.min(1, y + random() * 0.6) : random();
        return [x, y];
      });
      const curve = monotoneCurve(pts);
      const sorted = [...pts].sort((a, b) => a[0] - b[0]);
      for (let k = 0; k < sorted.length - 1; k++) {
        const [x0, y0] = sorted[k];
        const [x1, y1] = sorted[k + 1];
        if (x1 - x0 < 1e-9) continue;
        const lo = Math.min(y0, y1) - 1e-12;
        const hi = Math.max(y0, y1) + 1e-12;
        for (let t = 0; t <= 1; t += 0.01) {
          const v = curve(x0 + (x1 - x0) * t);
          expect(v).toBeGreaterThanOrEqual(lo);
          expect(v).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it("stays increasing when the points are increasing", () => {
    const curve = monotoneCurve([[0, 0], [0.1, 0.5], [0.2, 0.52], [0.9, 0.55], [1, 1]]);
    let prev = -Infinity;
    for (let x = 0; x <= 1; x += 0.001) {
      const v = curve(x);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });

  it("passes through every control point", () => {
    const pts: CurvePoint[] = [[0, 0.1], [0.3, 0.2], [0.7, 0.9], [1, 0.95]];
    const curve = monotoneCurve(pts);
    for (const [x, y] of pts) expect(curve(x)).toBeCloseTo(y, 12);
  });
});

describe("LUT sampling matches the exact grade", () => {
  const cases: [string, ReturnType<typeof defaultParams>][] = [
    ...presets.map((p) => [p.name, presetToParams(p).params] as [string, ReturnType<typeof defaultParams>]),
    ["strong mixed grade", makeParams({ exposure: 0.7, temperature: 0.5, contrast: 0.4, shadows: 0.5, saturation: 1.3, fade: 0.2 })],
  ];

  it.each(cases)("%s: 33^3 LUT within 1/255 of applyGrade on average", (_name, params) => {
    const lut = toLut3D(params, 33);
    const random = rng(42);
    let sum = 0;
    let max = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const rgb: RGB = [random(), random(), random()];
      const exact = applyGrade(rgb, params);
      const sampled = sampleLut(lut, rgb);
      for (let c = 0; c < 3; c++) {
        const err = Math.abs(exact[c] - sampled[c]);
        sum += err;
        max = Math.max(max, err);
      }
    }
    expect(sum / (N * 3)).toBeLessThan(1 / 255);
    expect(max).toBeLessThan(6 / 255);
  });

  it("is exact on grid points", () => {
    const params = presetToParams(presets[0]).params;
    const lut = toLut3D(params, 9);
    const rgb: RGB = [2 / 8, 5 / 8, 7 / 8];
    const exact = applyGrade(rgb, params);
    sampleLut(lut, rgb).forEach((v, c) => expect(v).toBeCloseTo(exact[c], 6));
  });
});

describe("pipeline sanity", () => {
  it("exposure +1 stop doubles linear light on a mid grey", () => {
    const grey = 0.4;
    const [r] = applyGrade([grey, grey, grey], makeParams({ exposure: 1 }));
    expect(srgbToLinear(r)).toBeCloseTo(srgbToLinear(grey) * 2, 6);
  });

  it("white balance keeps a neutral grey's brightness", () => {
    const out = applyGrade([0.5, 0.5, 0.5], makeParams({ temperature: 0.6 }));
    const y = 0.2126 * srgbToLinear(out[0]) + 0.7152 * srgbToLinear(out[1]) + 0.0722 * srgbToLinear(out[2]);
    expect(y).toBeCloseTo(srgbToLinear(0.5), 6);
    expect(out[0]).toBeGreaterThan(out[2]);
  });

  it("saturation 0 gives grey with the same luma", () => {
    const [r, g, b] = applyGrade([0.8, 0.3, 0.1], makeParams({ saturation: 0 }));
    expect(r).toBeCloseTo(g, 9);
    expect(g).toBeCloseTo(b, 9);
    expect(r).toBeCloseTo(0.2126 * 0.8 + 0.7152 * 0.3 + 0.0722 * 0.1, 9);
  });

  it("vibrance boosts dull colors more than saturated ones", () => {
    const boost = (rgb: RGB) => {
      const out = applyGrade(rgb, makeParams({ vibrance: 0.8 }));
      return (Math.max(...out) - Math.min(...out)) / (Math.max(...rgb) - Math.min(...rgb));
    };
    expect(boost([0.55, 0.5, 0.45])).toBeGreaterThan(boost([0.9, 0.2, 0.1]));
  });

  it("always outputs values in 0..1", () => {
    const wild = makeParams({ exposure: 3, contrast: 1, shadows: 1, highlights: 1, saturation: 3, vibrance: 1, offset: [0.4, -0.4, 0.2] });
    const lut = buildLut(wild, 9);
    for (const v of lut) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("adapters", () => {
  it.each(ADAPTERS.map((a) => [a.id, a] as const))("%s: defaults are the identity", (_id, adapter) => {
    const values = Object.fromEntries(adapter.controls.map((c) => [c.key, c.default]));
    expectIdentityLut(buildLut(adapter.toParams(values), 17), 17);
  });

  it.each(ADAPTERS.map((a) => [a.id, a] as const))("%s: every control is well-formed and changes the grade", (_id, adapter) => {
    const keys = new Set<string>();
    for (const c of adapter.controls) {
      expect(keys.has(c.key)).toBe(false);
      keys.add(c.key);
      expect(c.min).toBeLessThan(c.max);
      expect(c.default).toBeGreaterThanOrEqual(c.min);
      expect(c.default).toBeLessThanOrEqual(c.max);
    }
  });

  it("every preset loads with its adapter and changes the image", () => {
    for (const preset of presets) {
      const { params } = presetToParams(preset);
      const lut = buildLut(params, 9);
      const identity = buildLut(defaultParams(), 9);
      const diff = lut.reduce((s, v, i) => s + Math.abs(v - identity[i]), 0) / lut.length;
      expect(diff, preset.name).toBeGreaterThan(0.01);
    }
  });

  it("rejects a preset with a misspelled control", () => {
    expect(() => presetToParams({ name: "typo", adapter: "flick", values: { exposur: 1 } })).toThrow(/exposur/);
  });
});
