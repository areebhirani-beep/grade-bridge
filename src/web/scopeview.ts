// Draws the scopes on a 2D canvas: traces as an ImageData density plot,
// graticule as vector lines on top. The math lives in scopes.ts.

import type { Pixels } from "./frame.ts";
import { BAR_TARGETS, SKIN_LINE_DEG, cbcr709, vectorscope, waveform } from "./scopes.ts";

export type ScopeKind = "waveform" | "parade" | "vector";

// 128 levels (0.8 IRE each) is finer than the plot can show at this size, and
// coarse enough that a smooth gradient fills every bin instead of striping.
const LEVELS = 128;
const TRACE: Record<string, [number, number, number]> = {
  luma: [236, 236, 236],
  r: [255, 92, 84],
  g: [96, 220, 110],
  b: [92, 140, 255],
};

export class ScopeView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private plot = document.createElement("canvas");
  private plotCtx = this.plot.getContext("2d")!;
  kind: ScopeKind = "waveform";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  private fit(): { w: number; h: number; dpr: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr));
    const h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h, dpr };
  }

  draw(px: Pixels | null): void {
    const { w, h, dpr } = this.fit();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${10 * dpr}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    if (this.kind === "vector") this.drawVector(px, w, h, dpr);
    else this.drawWaveform(px, w, h, dpr, this.kind === "parade");
  }

  private drawWaveform(px: Pixels | null, w: number, h: number, dpr: number, parade: boolean): void {
    const ctx = this.ctx;
    const left = Math.round(26 * dpr);
    const right = Math.round(6 * dpr);
    const top = Math.round(8 * dpr);
    const bottom = Math.round(8 * dpr);
    const pw = w - left - right;
    const ph = h - top - bottom;
    const yOf = (ire: number) => Math.round(top + ph - (ire / 100) * ph) + 0.5;

    // Graticule: a line every 10 IRE, labels every 20.
    ctx.lineWidth = 1;
    for (let ire = 0; ire <= 100; ire += 10) {
      const y = yOf(ire);
      ctx.strokeStyle = ire === 0 || ire === 100 ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.08)";
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + pw, y);
      ctx.stroke();
      if (ire % 20 === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.42)";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(String(ire), left - 5 * dpr, y);
      }
    }

    if (!px) return;
    const traces = parade ? (["r", "g", "b"] as const) : (["luma"] as const);
    const gap = parade ? Math.round(6 * dpr) : 0;
    const cellW = Math.floor((pw - gap * (traces.length - 1)) / traces.length);
    // Every scope column must get the same number of picture columns, or the
    // trace shows striping that is not in the picture.
    const cols = Math.max(16, Math.floor(px.width / Math.max(1, Math.ceil(px.width / cellW))));
    const bins = waveform(px, cols, LEVELS, parade ? "rgb" : "luma");
    const gain = (LEVELS / bins.perColumn) * 0.35;

    for (let t = 0; t < traces.length; t++) {
      const counts = bins.traces[t];
      const [cr, cg, cb] = TRACE[traces[t]];
      if (this.plot.width !== cols || this.plot.height !== LEVELS) {
        this.plot.width = cols;
        this.plot.height = LEVELS;
      }
      const img = this.plotCtx.createImageData(cols, LEVELS);
      for (let level = 0; level < LEVELS; level++) {
        const row = (LEVELS - 1 - level) * cols; // white at the top
        for (let c = 0; c < cols; c++) {
          const n = counts[level * cols + c];
          if (!n) continue;
          const o = (row + c) * 4;
          img.data[o] = cr;
          img.data[o + 1] = cg;
          img.data[o + 2] = cb;
          img.data[o + 3] = Math.min(255, Math.sqrt(n * gain) * 255);
        }
      }
      this.plotCtx.putImageData(img, 0, 0);
      const x = left + t * (cellW + gap);
      ctx.imageSmoothingEnabled = true;
      ctx.globalCompositeOperation = "lighter";
      // Map level 0 and level 255 exactly onto the 0 and 100 lines.
      const y0 = yOf(100) - 0.5;
      const y1 = yOf(0) - 0.5;
      const halfLevel = (y1 - y0) / (LEVELS - 1) / 2;
      ctx.drawImage(this.plot, x, y0 - halfLevel, cellW, y1 - y0 + 2 * halfLevel);
      ctx.globalCompositeOperation = "source-over";
    }
  }

  private drawVector(px: Pixels | null, w: number, h: number, dpr: number): void {
    const ctx = this.ctx;
    const pad = Math.round(10 * dpr);
    const size = Math.min(w, h) - 2 * pad;
    const n = Math.max(64, Math.min(size, 512));
    const x0 = Math.round((w - size) / 2);
    const y0 = Math.round((h - size) / 2);
    const cx = x0 + size / 2;
    const cy = y0 + size / 2;
    const radius = size / 2;
    // Cb/Cr of -0.5..0.5 spans the full square, so 0.5 is the radius.
    const toXY = (cb: number, cr: number): [number, number] => [cx + cb * 2 * radius, cy - cr * 2 * radius];

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // Skin-tone line.
    const a = (SKIN_LINE_DEG * Math.PI) / 180;
    ctx.save();
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.strokeStyle = "rgba(255,255,255,0.32)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * radius, cy - Math.sin(a) * radius);
    ctx.stroke();
    ctx.restore();

    // 75% color-bar targets.
    const box = 5 * dpr;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const t of BAR_TARGETS) {
      const [cb, cr] = cbcr709(...t.rgb);
      const [x, y] = toXY(cb, cr);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.strokeRect(Math.round(x - box) + 0.5, Math.round(y - box) + 0.5, box * 2, box * 2);
      const len = Math.hypot(x - cx, y - cy) || 1;
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.fillText(t.label, x + ((x - cx) / len) * 13 * dpr, y + ((y - cy) / len) * 13 * dpr);
    }

    if (!px) return;
    const bins = vectorscope(px, n);
    const total = px.width * px.height;
    const expected = total / (n * n * 0.05);
    if (this.plot.width !== n || this.plot.height !== n) {
      this.plot.width = n;
      this.plot.height = n;
    }
    const img = this.plotCtx.createImageData(n, n);
    for (let i = 0; i < bins.length; i++) {
      const c = bins[i];
      if (!c) continue;
      const o = i * 4;
      img.data[o] = 236;
      img.data[o + 1] = 236;
      img.data[o + 2] = 236;
      img.data[o + 3] = Math.min(255, Math.sqrt(c / expected) * 255);
    }
    this.plotCtx.putImageData(img, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(this.plot, x0, y0, size, size);
    ctx.globalCompositeOperation = "source-over";
  }
}
