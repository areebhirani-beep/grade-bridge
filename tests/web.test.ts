import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { buildLut, mixWithIdentity, sampleLut } from "../src/core/lut.ts";
import { parseCube, serializeCube } from "../src/core/cube.ts";
import type { RGB } from "../src/core/params.ts";
import { presetToParams, type Preset } from "../src/adapters/index.ts";
import { applyLutToPixels } from "../src/web/frame.ts";
import {
  BAR_TARGETS, SKIN_LINE_DEG, cbcr709, levelBin, luma709, vectorAngle, vectorCell, vectorscope, waveform, waveformColumn,
} from "../src/web/scopes.ts";

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const presets: Preset[] = readdirSync("presets")
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(`presets/${f}`, "utf8")));

/** What the preview shader does: mix(src, texture(lut, src), k). */
const shaderMix = (lut: Float32Array, size: number, rgb: RGB, k: number): RGB => {
  const graded = sampleLut({ size, data: lut }, rgb);
  return [0, 1, 2].map((c) => rgb[c] + (graded[c] - rgb[c]) * k) as RGB;
};

describe("intensity mix", () => {
  const lut = buildLut(presetToParams(presets.find((p) => p.name === "Teal & Orange")!).params, 33);

  it.each([0, 0.25, 0.6, 1])("a LUT mixed at %s samples to the shader's mix(original, graded)", (k) => {
    const mixed = mixWithIdentity(lut, 33, k);
    const random = rng(11);
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const rgb: RGB = [random(), random(), random()];
      const a = sampleLut({ size: 33, data: mixed }, rgb);
      const b = shaderMix(lut, 33, rgb, k);
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a[c] - b[c]));
    }
    // Float32 storage only; far below one 16-bit step.
    expect(worst).toBeLessThan(1e-6);
  });

  it("0% is the identity and 100% is the LUT unchanged", () => {
    const zero = mixWithIdentity(lut, 33, 0);
    for (let b = 0, i = 0; b < 33; b++)
      for (let g = 0; g < 33; g++)
        for (let r = 0; r < 33; r++, i += 3) {
          expect(zero[i]).toBeCloseTo(r / 32, 6);
          expect(zero[i + 1]).toBeCloseTo(g / 32, 6);
          expect(zero[i + 2]).toBeCloseTo(b / 32, 6);
        }
    expect(Array.from(mixWithIdentity(lut, 33, 1))).toEqual(Array.from(lut));
  });

  it("respects a non-default DOMAIN when blending toward identity", () => {
    const size = 5;
    const min: RGB = [-0.1, 0, 0.2];
    const max: RGB = [1.1, 2, 0.8];
    const zero = mixWithIdentity(new Float32Array(size ** 3 * 3), size, 0, min, max);
    // Grid point (r=4, g=2, b=0) is at domain coordinates (1.1, 1.0, 0.2).
    const i = ((0 * size + 2) * size + 4) * 3;
    expect([zero[i], zero[i + 1], zero[i + 2]].map((v) => Number(v.toFixed(6)))).toEqual([1.1, 1, 0.2]);
  });

  it("survives the .cube round trip, so the exported file matches the preview", () => {
    const mixed = mixWithIdentity(lut, 33, 0.6);
    const parsed = parseCube(serializeCube({ size: 33, data: mixed, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }, "T (Mixed at 60% intensity)"));
    expect(parsed.title).toBe("T (Mixed at 60% intensity)");
    const random = rng(5);
    for (let i = 0; i < 500; i++) {
      const rgb: RGB = [random(), random(), random()];
      const a = sampleLut(parsed, rgb);
      const b = shaderMix(lut, 33, rgb, 0.6);
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c] - b[c])).toBeLessThan(2e-6);
    }
  });
});

describe("CPU LUT on pixels (looks strip and scopes)", () => {
  it("matches sampleLut to within 8-bit rounding", () => {
    const lut = buildLut(presetToParams(presets[0]).params, 33);
    const random = rng(3);
    const n = 2000;
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor(random() * 256);
    const out = applyLutToPixels({ width: n, height: 1, data }, { size: 33, data: lut });
    for (let p = 0; p < n; p++) {
      const rgb: RGB = [data[p * 4] / 255, data[p * 4 + 1] / 255, data[p * 4 + 2] / 255];
      const exact = sampleLut({ size: 33, data: lut }, rgb);
      for (let c = 0; c < 3; c++) expect(Math.abs(out[p * 4 + c] - exact[c] * 255)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(out[p * 4 + 3]).toBe(data[p * 4 + 3]);
    }
  });
});

/** An RGBA image from a per-pixel function. */
function image(width: number, height: number, f: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data.set([...f(x, y), 255], i);
    }
  return { width, height, data };
}

describe("waveform binning", () => {
  it("maps black to level 0 and white to the top level", () => {
    expect(levelBin(0, 256)).toBe(0);
    expect(levelBin(1, 256)).toBe(255);
    expect(levelBin(0.5, 101)).toBe(50);
  });

  it("puts picture columns in the matching scope columns", () => {
    expect(waveformColumn(0, 640, 64)).toBe(0);
    expect(waveformColumn(9, 640, 64)).toBe(0);
    expect(waveformColumn(10, 640, 64)).toBe(1);
    expect(waveformColumn(639, 640, 64)).toBe(63);
  });

  it("a horizontal grey ramp draws a diagonal line from 0 to 100", () => {
    const w = 256;
    const px = image(w, 4, (x) => [x, x, x]);
    const bins = waveform(px, w, 256, "luma");
    for (let col = 0; col < w; col++) {
      // All 4 pixels of column `col` (value col) land in level `col`.
      expect(bins.traces[0][col * w + col]).toBe(4);
    }
    const total = bins.traces[0].reduce((s, v) => s + v, 0);
    expect(total).toBe(w * 4);
  });

  it("uses Rec.709 luma weights, so pure green reads far higher than pure blue", () => {
    expect(luma709(0, 1, 0)).toBeCloseTo(0.7152, 6);
    const px = image(3, 1, (x) => (x === 0 ? [255, 0, 0] : x === 1 ? [0, 255, 0] : [0, 0, 255]));
    const bins = waveform(px, 3, 256, "luma");
    const levelOf = (col: number) => [...Array(256).keys()].find((l) => bins.traces[0][l * 3 + col] > 0);
    expect(levelOf(0)).toBe(Math.round(0.2126 * 255));
    expect(levelOf(1)).toBe(Math.round(0.7152 * 255));
    expect(levelOf(2)).toBe(Math.round(0.0722 * 255));
  });

  it("parade separates the channels", () => {
    const px = image(2, 2, () => [255, 128, 0]);
    const bins = waveform(px, 1, 256, "rgb");
    expect(bins.traces[0][255]).toBe(4);
    expect(bins.traces[1][128]).toBe(4);
    expect(bins.traces[2][0]).toBe(4);
  });
});

describe("vectorscope", () => {
  it("neutral greys sit in the center", () => {
    for (const v of [0, 0.2, 0.5, 1]) {
      const [cb, cr] = cbcr709(v, v, v);
      expect(Math.abs(cb)).toBeLessThan(1e-12);
      expect(Math.abs(cr)).toBeLessThan(1e-12);
    }
    const bins = vectorscope(image(10, 10, (x) => [x * 25, x * 25, x * 25]), 65);
    expect(bins[32 * 65 + 32]).toBe(100);
  });

  it("pure blue is at +Cb 0.5 and pure red at +Cr 0.5 (the scale edge)", () => {
    expect(cbcr709(0, 0, 1)[0]).toBeCloseTo(0.5, 9);
    expect(cbcr709(1, 0, 0)[1]).toBeCloseTo(0.5, 9);
    expect(vectorCell(0.5, 0, 101)).toEqual([100, 50]);
    expect(vectorCell(0, 0.5, 101)).toEqual([50, 0]); // red is up
  });

  it("the 75% bar targets land in the standard order around the circle", () => {
    const angles = Object.fromEntries(BAR_TARGETS.map((t) => [t.label, vectorAngle(...t.rgb)]));
    // Counter-clockwise from +Cb: Mg, R, Yl, G, Cy, B.
    const order = Object.entries(angles).sort((a, b) => a[1] - b[1]).map(([l]) => l);
    expect(order).toEqual(["Mg", "R", "Yl", "G", "Cy", "B"]);
  });

  it("the test chart's skin swatches fall near the skin-tone line", () => {
    const skin: RGB[] = [[246, 225, 205], [232, 196, 168], [210, 160, 125], [178, 122, 88], [132, 88, 60], [86, 58, 42]];
    for (const s of skin) {
      const a = vectorAngle(s[0] / 255, s[1] / 255, s[2] / 255);
      expect(Math.abs(a - SKIN_LINE_DEG), `swatch ${s}`).toBeLessThan(15);
    }
  });
});
