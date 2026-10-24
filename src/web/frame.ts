// CPU side of the preview: grab a downscaled copy of the current frame and grade
// it with a LUT. The look thumbnails and the scopes are both built from this, so
// they show the same trilinear lookup an editor does with the exported file.

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, as ImageData stores it. */
  data: Uint8ClampedArray;
}

export interface LutRef {
  size: number;
  data: Float32Array;
  domainMin?: ArrayLike<number>;
  domainMax?: ArrayLike<number>;
}

/** Grades RGBA pixels through a 3D LUT with trilinear interpolation. Alpha is copied. */
export function applyLutToPixels(src: Pixels, lut: LutRef, out?: Uint8ClampedArray): Uint8ClampedArray {
  const { size, data } = lut;
  const dst = out ?? new Uint8ClampedArray(src.data.length);
  const s = src.data;
  const n = size - 1;
  const min = lut.domainMin ?? [0, 0, 0];
  const max = lut.domainMax ?? [1, 1, 1];
  // Per channel: input code value 0..255 -> grid position, precomputed once.
  const pos: Float32Array[] = [0, 1, 2].map((c) => {
    const t = new Float32Array(256);
    for (let v = 0; v < 256; v++) {
      const x = (v / 255 - min[c]) / (max[c] - min[c]);
      t[v] = Math.min(Math.max(x, 0), 1) * n;
    }
    return t;
  });
  const [pr, pg, pb] = pos;
  const sg = size * 3;
  const sb = size * size * 3;

  for (let i = 0; i < s.length; i += 4) {
    const fr0 = pr[s[i]];
    const fg0 = pg[s[i + 1]];
    const fb0 = pb[s[i + 2]];
    const r0 = Math.min(fr0 | 0, n - 1);
    const g0 = Math.min(fg0 | 0, n - 1);
    const b0 = Math.min(fb0 | 0, n - 1);
    const fr = fr0 - r0;
    const fg = fg0 - g0;
    const fb = fb0 - b0;
    const base = b0 * sb + g0 * sg + r0 * 3;
    for (let c = 0; c < 3; c++) {
      const o = base + c;
      const c00 = data[o] + (data[o + 3] - data[o]) * fr;
      const c10 = data[o + sg] + (data[o + sg + 3] - data[o + sg]) * fr;
      const c01 = data[o + sb] + (data[o + sb + 3] - data[o + sb]) * fr;
      const c11 = data[o + sb + sg] + (data[o + sb + sg + 3] - data[o + sb + sg]) * fr;
      const c0 = c00 + (c10 - c00) * fg;
      const c1 = c01 + (c11 - c01) * fg;
      dst[i + c] = Math.round((c0 + (c1 - c0) * fb) * 255);
    }
    dst[i + 3] = s[i + 3];
  }
  return dst;
}

type Drawable = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;

export function mediaSize(m: Drawable): { width: number; height: number } {
  if ("videoWidth" in m) return { width: m.videoWidth, height: m.videoHeight };
  if ("naturalWidth" in m) return { width: m.naturalWidth, height: m.naturalHeight };
  return { width: m.width, height: m.height };
}

let grabCanvas: HTMLCanvasElement | null = null;
let grabCtx: CanvasRenderingContext2D | null = null;

/**
 * Draws the media into a small canvas and reads it back. `fit: "contain"` keeps
 * the whole frame (scopes); `"cover"` crops to the box (thumbnails).
 */
export function grabFrame(media: Drawable, maxW: number, maxH: number, fit: "contain" | "cover" = "contain"): Pixels | null {
  const { width: w, height: h } = mediaSize(media);
  if (!w || !h) return null;
  let sx = 0, sy = 0, sw = w, sh = h, dw: number, dh: number;
  if (fit === "contain") {
    const k = Math.min(maxW / w, maxH / h, 1);
    dw = Math.max(1, Math.round(w * k));
    dh = Math.max(1, Math.round(h * k));
  } else {
    dw = maxW;
    dh = maxH;
    const target = maxW / maxH;
    if (w / h > target) {
      sw = h * target;
      sx = (w - sw) / 2;
    } else {
      sh = w / target;
      sy = (h - sh) / 2;
    }
  }
  if (!grabCanvas || !grabCtx) {
    grabCanvas = document.createElement("canvas");
    grabCtx = grabCanvas.getContext("2d", { willReadFrequently: true })!;
  }
  if (grabCanvas.width !== dw || grabCanvas.height !== dh) {
    grabCanvas.width = dw;
    grabCanvas.height = dh;
  }
  grabCtx.imageSmoothingEnabled = true;
  grabCtx.imageSmoothingQuality = "high";
  grabCtx.drawImage(media, sx, sy, sw, sh, 0, 0, dw, dh);
  const img = grabCtx.getImageData(0, 0, dw, dh);
  return { width: dw, height: dh, data: img.data };
}
