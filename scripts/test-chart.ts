// A synthetic test chart, used as the app's fallback image and by `npm run verify`.
// Rows: hue sweep (white -> full color -> black), grey ramp, approximate skin-tone
// swatches, and the 24-patch ColorChecker layout. Values are approximate sRGB, so
// treat it as a test pattern, not a calibration target.

import type { RGB } from "../src/core/params.ts";
import type { RgbImage } from "./image-io.ts";

const COLOR_CHECKER: number[][] = [
  [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
  [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
  [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
  [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
];

const SKIN_TONES: number[][] = [
  [246, 225, 205], [232, 196, 168], [210, 160, 125], [178, 122, 88], [132, 88, 60], [86, 58, 42],
];

function hsv(h: number, s: number, v: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

export function makeTestChart(width: number, height: number): RgbImage {
  const data = new Uint8Array(width * height * 3);
  const sweepEnd = Math.round(height * 0.42);
  const rampEnd = Math.round(height * 0.5);
  const skinEnd = Math.round(height * 0.62);
  const gap = Math.max(4, Math.round(width / 160));
  const border = 26 / 255;

  const swatch = (palette: number[][], cols: number, rows: number, x: number, y: number, top: number, bottom: number): RGB => {
    const cw = width / cols;
    const ch = (bottom - top) / rows;
    const col = Math.min(cols - 1, Math.floor(x / cw));
    const row = Math.min(rows - 1, Math.floor((y - top) / ch));
    const inside = x - col * cw > gap && x - col * cw < cw - gap && y - top - row * ch > gap && y - top - row * ch < ch - gap;
    return inside ? (palette[row * cols + col].map((v) => v / 255) as RGB) : [border, border, border];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c: RGB;
      if (y < sweepEnd) {
        const t = y / (sweepEnd - 1);
        c = hsv(x / width, Math.min(1, t * 2), t < 0.5 ? 1 : 1 - (t - 0.5) * 2);
      } else if (y < rampEnd) {
        const g = x / (width - 1);
        c = [g, g, g];
      } else if (y < skinEnd) {
        c = swatch(SKIN_TONES, 6, 1, x, y, rampEnd, skinEnd);
      } else {
        c = swatch(COLOR_CHECKER, 6, 4, x, y, skinEnd, height);
      }
      for (let k = 0; k < 3; k++) data[(y * width + x) * 3 + k] = Math.round(c[k] * 255);
    }
  }
  return { width, height, data };
}
