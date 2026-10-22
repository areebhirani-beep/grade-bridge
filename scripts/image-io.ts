/**
 * Tiny image I/O on top of ffmpeg, so the scripts need no image libraries.
 * Images are raw 8-bit RGB buffers (rgb24): 3 bytes per pixel, row by row.
 */

import { spawnSync } from "node:child_process";

export interface RgbImage {
  width: number;
  height: number;
  data: Uint8Array;
}

function ffmpeg(args: string[], input?: Uint8Array): Buffer {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    input,
    maxBuffer: 1 << 30,
  });
  if (res.error) throw new Error(`Could not run ffmpeg: ${res.error.message}. Is it installed and on PATH?`);
  if (res.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed:\n${res.stderr.toString()}`);
  return res.stdout;
}

export function hasFfmpeg(): string | null {
  const res = spawnSync("ffmpeg", ["-version"]);
  return res.status === 0 ? res.stdout.toString().split("\n")[0] : null;
}

/** Encode a raw RGB image to PNG or JPEG (chosen by the file extension). */
export function writeImage(img: RgbImage, path: string): void {
  const quality = /\.jpe?g$/i.test(path) ? ["-q:v", "3"] : [];
  ffmpeg(["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${img.width}x${img.height}`, "-i", "-", ...quality, "-frames:v", "1", path], img.data);
}

/** Decode an image file to raw RGB, optionally through an ffmpeg filter chain (e.g. lut3d). */
export function readImage(path: string, width: number, height: number, filter?: string): RgbImage {
  const vf = filter ? ["-vf", filter] : [];
  const data = ffmpeg(["-i", path, ...vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  if (data.length !== width * height * 3) throw new Error(`Expected ${width}x${height} RGB from ${path}, got ${data.length} bytes`);
  return { width, height, data: new Uint8Array(data) };
}

/** Run ffmpeg on an image file and save the result to another file. */
export function filterImage(input: string, filter: string, output: string): void {
  const quality = /\.jpe?g$/i.test(output) ? ["-q:v", "3"] : [];
  ffmpeg(["-i", input, "-vf", filter, ...quality, "-frames:v", "1", output]);
}

/** Put images side by side (all must share a height). */
export function hstack(images: RgbImage[], gap = 8, gapColor = 16): RgbImage {
  const height = images[0].height;
  const width = images.reduce((s, im) => s + im.width, 0) + gap * (images.length - 1);
  const data = new Uint8Array(width * height * 3).fill(gapColor);
  let x0 = 0;
  for (const im of images) {
    for (let y = 0; y < height; y++) data.set(im.data.subarray(y * im.width * 3, (y + 1) * im.width * 3), (y * width + x0) * 3);
    x0 += im.width + gap;
  }
  return { width, height, data };
}
