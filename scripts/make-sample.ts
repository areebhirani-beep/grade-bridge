/**
 * Paints the bundled sample image (public/sample.jpg): a golden-hour lake
 * scene with sky, sun, hazy mountains, water, skin-like warm tones and deep
 * shadows, so every kind of grade has something to show on.
 *
 * It is procedural (no photo, no license questions). Run: npm run sample
 */

import { writeImage } from "./image-io.ts";

const W = 1600;
const H = 900;

// --- tiny deterministic value noise ----------------------------------------
function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, octaves = 5): number {
  let sum = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}

type C = [number, number, number];
const mix = (a: C, b: C, t: number): C => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

const horizon = 0.62;
const sun = { x: 0.68, y: 0.4, r: 0.03 };

function sky(x: number, y: number): C {
  const t = y / horizon;
  let c = mix([0.1, 0.2, 0.42], [0.42, 0.52, 0.72], smooth(0, 0.6, t));
  c = mix(c, [0.98, 0.66, 0.38], smooth(0.45, 1, t));
  const dx = (x - sun.x) * (W / H), dy = y - sun.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  c = mix(c, [1, 0.8, 0.55], Math.exp(-dist * 7) * 0.8);
  if (dist < sun.r) c = mix(c, [1, 0.97, 0.88], smooth(sun.r, sun.r * 0.8, dist));
  const cloud = smooth(0.52, 0.75, fbm(x * 4, y * 14)) * smooth(horizon, 0.15, y);
  const cloudLit = mix([0.55, 0.4, 0.5], [1, 0.72, 0.6], smooth(0.1, horizon, y));
  return mix(c, cloudLit, cloud * 0.85);
}

/** Ridge height (0 top .. 1 bottom) for a mountain layer at x. */
const ridge = (x: number, base: number, amp: number, seed: number) => base - amp * fbm(x * 3 + seed, seed, 6);

const layers: { base: number; amp: number; seed: number; color: C; haze: number }[] = [
  { base: horizon, amp: 0.26, seed: 1, color: [0.36, 0.38, 0.52], haze: 0.4 },
  { base: horizon, amp: 0.15, seed: 7, color: [0.16, 0.2, 0.24], haze: 0.22 },
  { base: horizon + 0.005, amp: 0.08, seed: 13, color: [0.05, 0.09, 0.06], haze: 0.05 },
];

function land(x: number, y: number): C | null {
  let c: C | null = null;
  for (const l of layers) {
    const top = ridge(x, l.base, l.amp, l.seed);
    if (y >= top) {
      const shade = 0.75 + 0.5 * fbm(x * 20 + l.seed, y * 20, 3);
      const lc: C = [l.color[0] * shade, l.color[1] * shade, l.color[2] * shade];
      c = mix(lc, [0.86, 0.62, 0.5], l.haze * smooth(top + 0.2, top, y));
    }
  }
  return c;
}

function scene(x: number, y: number): C {
  if (y < horizon) return land(x, y) ?? sky(x, y);

  // Water: a rippled, darkened reflection of what is above the horizon.
  const depth = (y - horizon) / (1 - horizon);
  const ripple = (fbm(x * 40, y * 220, 3) - 0.5) * 0.02 * (0.3 + depth);
  const ry = horizon - (y - horizon) * 1.1;
  const rx = x + ripple;
  let c = land(rx, ry) ?? sky(rx, Math.max(0, ry));
  c = mix(c, [0.05, 0.12, 0.16], 0.25 + 0.45 * depth);
  const glint = Math.exp(-Math.abs(x - sun.x) * 30) * smooth(0.55, 0.75, fbm(x * 60, y * 400, 2)) * (1 - depth);
  c = mix(c, [1, 0.85, 0.6], glint * 0.9);

  // Foreground shore with grass, a wooden dock and a red canoe.
  const shore = 0.88 - 0.05 * fbm(x * 6, 3, 4);
  if (y > shore) {
    const g = fbm(x * 90, y * 30, 3);
    c = mix([0.1, 0.16, 0.06], [0.42, 0.5, 0.16], g * smooth(shore, 1, y) + 0.2);
  }
  const dockTop = 0.7;
  if (y > dockTop) {
    const halfWidth = 0.025 + (y - dockTop) * 0.55;
    const dx = x - (0.26 - (y - dockTop) * 0.4);
    if (Math.abs(dx) < halfWidth) {
      const plank = ((0.35 / (y - dockTop + 0.05)) % 1 + 1) % 1;
      const wood: C = mix([0.78, 0.55, 0.38], [0.52, 0.33, 0.22], fbm(x * 8, plank * 3 + y * 200, 3));
      const lit = 0.75 + 0.35 * (1 - Math.abs(dx) / halfWidth);
      c = plank < 0.08 ? [0.12, 0.08, 0.06] : [wood[0] * lit, wood[1] * lit, wood[2] * lit];
    }
  }
  const canoeY = 0.735, canoeX = 0.52;
  const cx = (x - canoeX) / 0.08, cy = (y - canoeY) / 0.016;
  if (cx * cx + cy * cy < 1 && cy > -0.2) c = mix([0.8, 0.12, 0.08], [0.45, 0.05, 0.04], clamp(cy + 0.4));
  return c;
}

const data = new Uint8Array(W * H * 3);
for (let j = 0; j < H; j++) {
  for (let i = 0; i < W; i++) {
    const c = scene(i / W, j / H);
    const vignette = 1 - 0.35 * ((i / W - 0.5) ** 2 + (j / H - 0.5) ** 2) * 2;
    const grain = (hash(i, j + 9999) - 0.5) * 0.012;
    for (let k = 0; k < 3; k++) data[(j * W + i) * 3 + k] = Math.round(clamp(c[k] * vignette + grain) * 255);
  }
}
writeImage({ width: W, height: H, data }, "public/sample.jpg");
console.log(`Wrote public/sample.jpg (${W}x${H})`);
