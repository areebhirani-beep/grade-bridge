// The grade sampled on a size^3 grid of input colors. An editor grades a pixel by
// blending the 8 stored colors around it. Red changes fastest, the same order as
// a .cube file, so serializing is a straight copy.

import { compileGrade } from "./pipeline.ts";
import type { GradeParams, RGB } from "./params.ts";

export interface Lut3D {
  size: number;
  /** size^3 * 3 floats, index = ((b * size + g) * size + r) * 3. */
  data: Float32Array;
  domainMin: RGB;
  domainMax: RGB;
}

export const LUT_SIZES = [33, 65] as const;

export function buildLut(params: GradeParams, size = 33): Float32Array {
  if (!Number.isInteger(size) || size < 2 || size > 256) throw new Error(`LUT size must be an integer from 2 to 256, got ${size}`);
  const grade = compileGrade(params);
  const data = new Float32Array(size * size * size * 3);
  const step = 1 / (size - 1);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        grade(r * step, g * step, b * step, data, i);
        i += 3;
      }
    }
  }
  return data;
}

export function toLut3D(params: GradeParams, size = 33): Lut3D {
  return { size, data: buildLut(params, size), domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}

/** Trilinear lookup, as editors do it. */
export function sampleLut(lut: Pick<Lut3D, "size" | "data"> & Partial<Lut3D>, rgb: RGB): RGB {
  const { size, data } = lut;
  const min = lut.domainMin ?? [0, 0, 0];
  const max = lut.domainMax ?? [1, 1, 1];
  const n = size - 1;

  const pos = [0, 1, 2].map((c) => {
    const t = (rgb[c] - min[c]) / (max[c] - min[c]);
    return Math.min(Math.max(t, 0), 1) * n;
  });
  const lo = pos.map((p) => Math.min(Math.floor(p), n - 1));
  const f = pos.map((p, c) => p - lo[c]);

  const at = (r: number, g: number, b: number, ch: number) => data[((b * size + g) * size + r) * 3 + ch];
  const out: RGB = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const [r0, g0, b0] = lo;
    const [fr, fg, fb] = f;
    const c00 = at(r0, g0, b0, ch) * (1 - fr) + at(r0 + 1, g0, b0, ch) * fr;
    const c10 = at(r0, g0 + 1, b0, ch) * (1 - fr) + at(r0 + 1, g0 + 1, b0, ch) * fr;
    const c01 = at(r0, g0, b0 + 1, ch) * (1 - fr) + at(r0 + 1, g0, b0 + 1, ch) * fr;
    const c11 = at(r0, g0 + 1, b0 + 1, ch) * (1 - fr) + at(r0 + 1, g0 + 1, b0 + 1, ch) * fr;
    const c0 = c00 * (1 - fg) + c10 * fg;
    const c1 = c01 * (1 - fg) + c11 * fg;
    out[ch] = c0 * (1 - fb) + c1 * fb;
  }
  return out;
}
