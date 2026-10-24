// Scope math, kept free of any drawing so it can be unit tested.
//
// All three scopes read display-encoded 8-bit values (what the LUT outputs) and
// use Rec.709 weights, as Resolve and Premiere do for Rec.709 timelines.
//   Waveform: for each column of the picture, how many pixels sit at each luma
//             level. 0 IRE = code 0, 100 IRE = code 255 (full range).
//   Parade:   the same thing for R, G and B separately.
//   Vector:   each pixel's hue and saturation as a point, using the Rec.709
//             color-difference signals Cb (x axis) and Cr (y axis).

import type { Pixels } from "./frame.ts";

export const KR = 0.2126;
export const KG = 0.7152;
export const KB = 0.0722;

/** Rec.709 luma (Y') of display-encoded values, 0..1 in, 0..1 out. */
export const luma709 = (r: number, g: number, b: number) => KR * r + KG * g + KB * b;

/** Rec.709 color difference, each in -0.5..0.5. Cb = (B'-Y')/1.8556, Cr = (R'-Y')/1.5748. */
export function cbcr709(r: number, g: number, b: number): [number, number] {
  const y = luma709(r, g, b);
  return [(b - y) / (2 * (1 - KB)), (r - y) / (2 * (1 - KR))];
}

/**
 * Angle of the skin-tone line ("I line"), in degrees counter-clockwise from the
 * +Cb axis. Most skin, of any complexion, falls close to it.
 */
export const SKIN_LINE_DEG = 123;

/** Waveform column for picture column x, when the picture is `width` wide and the scope has `cols` columns. */
export const waveformColumn = (x: number, width: number, cols: number) => Math.min(cols - 1, Math.floor((x * cols) / width));

/** Level bin (0..levels-1) for a 0..1 value; 0 is black, levels-1 is white. */
export const levelBin = (v: number, levels: number) => Math.min(levels - 1, Math.max(0, Math.round(v * (levels - 1))));

export interface WaveformBins {
  cols: number;
  levels: number;
  /** One count array per trace: [luma] or [R, G, B]. Index = level * cols + col. */
  traces: Uint32Array[];
  /** Pixels that landed in each column, used to normalize brightness. */
  perColumn: number;
}

export function waveform(px: Pixels, cols: number, levels: number, mode: "luma" | "rgb"): WaveformBins {
  const { width, height, data } = px;
  const traces = mode === "luma" ? [new Uint32Array(cols * levels)] : [0, 1, 2].map(() => new Uint32Array(cols * levels));
  const colOf = new Int32Array(width);
  for (let x = 0; x < width; x++) colOf[x] = waveformColumn(x, width, cols);
  const lv = levels - 1;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      const col = colOf[x];
      if (mode === "luma") {
        const v = (KR * data[i] + KG * data[i + 1] + KB * data[i + 2]) / 255;
        traces[0][Math.round(v * lv) * cols + col]++;
      } else {
        for (let c = 0; c < 3; c++) traces[c][Math.round((data[i + c] / 255) * lv) * cols + col]++;
      }
    }
  }
  return { cols, levels, traces, perColumn: (height * width) / cols };
}

/** Grid cell for a Cb/Cr pair on an n x n vectorscope. Cb grows to the right, Cr grows upward. */
export function vectorCell(cb: number, cr: number, n: number): [number, number] {
  const x = Math.round((cb + 0.5) * (n - 1));
  const y = Math.round((0.5 - cr) * (n - 1));
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

export function vectorscope(px: Pixels, n: number): Uint32Array {
  const bins = new Uint32Array(n * n);
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const [cb, cr] = cbcr709(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    const [x, y] = vectorCell(cb, cr, n);
    bins[y * n + x]++;
  }
  return bins;
}

/** Hue angle of a color on the vectorscope, degrees counter-clockwise from +Cb, 0..360. */
export function vectorAngle(r: number, g: number, b: number): number {
  const [cb, cr] = cbcr709(r, g, b);
  return ((Math.atan2(cr, cb) * 180) / Math.PI + 360) % 360;
}

/** The six 75% color-bar targets every vectorscope graticule marks. */
export const BAR_TARGETS: { label: string; rgb: [number, number, number] }[] = [
  { label: "R", rgb: [0.75, 0, 0] },
  { label: "Mg", rgb: [0.75, 0, 0.75] },
  { label: "B", rgb: [0, 0, 0.75] },
  { label: "Cy", rgb: [0, 0.75, 0.75] },
  { label: "G", rgb: [0, 0.75, 0] },
  { label: "Yl", rgb: [0.75, 0.75, 0] },
];
