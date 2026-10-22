/**
 * Proves an exported .cube works in a real, independent pipeline: ffmpeg.
 *
 *   1. Paint a test chart (hue/brightness sweep, grey ramp, 24 color patches).
 *   2. Export every preset to .cube.
 *   3. Grade the chart twice: ffmpeg's lut3d filter reading our .cube, and
 *      our own exact applyGrade() math.
 *   4. Compare them per channel. If the .cube were wrong (axis order, domain,
 *      off-by-one in the grid) the error would be tens of levels, not ~1.
 *   5. Save before/after images to verify-out/ for demos.
 *
 * Run: npm run verify
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPreset, presetToParams } from "../src/adapters/index.ts";
import { serializeCube } from "../src/core/cube.ts";
import { sampleLut, toLut3D } from "../src/core/lut.ts";
import type { RGB } from "../src/core/params.ts";
import { compileGrade } from "../src/core/pipeline.ts";
import { filterImage, hasFfmpeg, hstack, readImage, writeImage, type RgbImage } from "./image-io.ts";

const OUT = "verify-out";
const LUT_SIZE = 33;
/** Pass/fail limits, in 8-bit levels (1 level = 1/255). */
const MAX_MEAN_ERROR = 1.5;
const MAX_ABS_ERROR = 6;
/** A deliberately broken .cube must be at least this far off, or the check is not sensitive enough. */
const MIN_BROKEN_ERROR = 5;

// The classic 24-patch ColorChecker, approximate sRGB values.
const COLOR_CHECKER: RGB[] = [
  [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
  [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
  [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
  [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
].map((c) => c.map((v) => v / 255) as RGB);

function hsv(h: number, s: number, v: number): RGB {
  const f = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

function makeTestChart(width = 768, height = 512): RgbImage {
  const data = new Uint8Array(width * height * 3);
  const put = (x: number, y: number, c: RGB) => c.forEach((v, k) => (data[(y * width + x) * 3 + k] = Math.round(v * 255)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c: RGB;
      if (y < 256) {
        // Hue across, and from white (top) through full color to black (bottom).
        const t = y / 255;
        const sat = Math.min(1, t * 2);
        const val = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
        c = hsv(x / width, sat, val);
      } else if (y < 304) {
        c = [x / (width - 1), x / (width - 1), x / (width - 1)]; // grey ramp
      } else {
        const col = Math.floor((x / width) * 6);
        const row = Math.floor(((y - 304) / (height - 304)) * 4);
        const inner = (x % (width / 6)) > 6 && ((y - 304) % ((height - 304) / 4)) > 6;
        c = inner ? COLOR_CHECKER[row * 6 + col] : [0.1, 0.1, 0.1];
      }
      put(x, y, c);
    }
  }
  return { width, height, data };
}

/** Grade an 8-bit image with a per-pixel function, rounding back to 8-bit. */
function gradeInJs(img: RgbImage, grade: (rgb: RGB) => RGB): RgbImage {
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < data.length; i += 3) {
    const out = grade([img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255]);
    for (let k = 0; k < 3; k++) data[i + k] = Math.round(Math.min(1, Math.max(0, out[k])) * 255);
  }
  return { ...img, data };
}

interface ChannelStats {
  mean: RGB;
  max: RGB;
}

function compare(a: RgbImage, b: RgbImage): ChannelStats {
  const sum: RGB = [0, 0, 0];
  const max: RGB = [0, 0, 0];
  for (let i = 0; i < a.data.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a.data[i + k] - b.data[i + k]);
      sum[k] += d;
      if (d > max[k]) max[k] = d;
    }
  }
  const n = a.data.length / 3;
  return { mean: sum.map((s) => s / n) as RGB, max };
}

const fmt = (v: RGB, digits: number) => v.map((x) => x.toFixed(digits)).join(" / ");

function main(): number {
  const ffmpegVersion = hasFfmpeg();
  if (!ffmpegVersion) {
    console.error("ffmpeg not found on PATH. Install it (e.g. `brew install ffmpeg`) and re-run.");
    return 1;
  }
  console.log(`Using ${ffmpegVersion}`);
  mkdirSync(join(OUT, "luts"), { recursive: true });

  const chart = makeTestChart();
  const chartPath = join(OUT, "test-chart.png");
  writeImage(chart, chartPath);

  const presetFiles = readdirSync("presets").filter((f) => f.endsWith(".json")).sort();
  const rows: string[] = [];
  const results: Record<string, unknown>[] = [];
  let failed = 0;

  for (const file of presetFiles) {
    const preset: unknown = JSON.parse(readFileSync(join("presets", file), "utf8"));
    if (!isPreset(preset)) throw new Error(`${file} is not a valid preset`);
    const id = file.replace(/\.json$/, "");
    const { params, adapter } = presetToParams(preset);

    // 2. Export.
    const lut = toLut3D(params, LUT_SIZE);
    const cubePath = join(OUT, "luts", `${id}.cube`);
    writeFileSync(cubePath, serializeCube(lut, preset.name));

    // 3. Apply with ffmpeg (default tetrahedral interpolation, like most editors) and with JS.
    const viaFfmpeg = readImage(chartPath, chart.width, chart.height, `lut3d=file=${cubePath}`);
    const grade = compileGrade(params);
    const viaMath = gradeInJs(chart, (rgb) => {
      const out: RGB = [0, 0, 0];
      grade(rgb[0], rgb[1], rgb[2], out, 0);
      return out;
    });
    const viaJsLut = gradeInJs(chart, (rgb) => sampleLut(lut, rgb));

    // 4. Compare.
    const vsMath = compare(viaFfmpeg, viaMath);
    const vsJsLut = compare(viaFfmpeg, viaJsLut);
    const worstMean = Math.max(...vsMath.mean);
    const worstMax = Math.max(...vsMath.max);
    const pass = worstMean < MAX_MEAN_ERROR && worstMax <= MAX_ABS_ERROR;
    if (!pass) failed++;

    // 5. Demo images: chart before | ffmpeg | exact math, and the sample photo before | after.
    writeImage(hstack([chart, viaFfmpeg, viaMath]), join(OUT, `${id}-chart.png`));
    filterImage("public/sample.jpg", `lut3d=file=${cubePath}`, join(OUT, `${id}-sample.jpg`));

    rows.push(
      `| ${preset.name} | ${adapter.id} | ${fmt(vsMath.mean, 3)} | ${fmt(vsMath.max, 0)} | ${Math.max(...vsJsLut.max)} | ${pass ? "PASS" : "FAIL"} |`,
    );
    results.push({ preset: preset.name, adapter: adapter.id, vsApplyGrade: vsMath, vsJsLut, pass });
  }

  // Negative control: write the first preset's LUT with blue changing fastest
  // (the most common .cube bug). ffmpeg must disagree badly, proving this
  // check can actually fail.
  const control = JSON.parse(readFileSync(join("presets", presetFiles[0]), "utf8"));
  const good = toLut3D(presetToParams(control).params, LUT_SIZE);
  const swapped = new Float32Array(good.data.length);
  const n = LUT_SIZE;
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++)
        for (let k = 0; k < 3; k++) swapped[((r * n + g) * n + b) * 3 + k] = good.data[((b * n + g) * n + r) * 3 + k];
  const brokenPath = join(OUT, "luts", "negative-control-axes-swapped.cube");
  writeFileSync(brokenPath, serializeCube({ ...good, data: swapped }, "broken on purpose"));
  const brokenGrade = compileGrade(presetToParams(control).params);
  const brokenStats = compare(
    readImage(chartPath, chart.width, chart.height, `lut3d=file=${brokenPath}`),
    gradeInJs(chart, (rgb) => {
      const out: RGB = [0, 0, 0];
      brokenGrade(rgb[0], rgb[1], rgb[2], out, 0);
      return out;
    }),
  );
  const brokenMean = Math.max(...brokenStats.mean);
  const controlCaught = brokenMean >= MIN_BROKEN_ERROR;
  if (!controlCaught) failed++;

  // The sample photo, ungraded, for the before shot.
  filterImage("public/sample.jpg", "null", join(OUT, "original-sample.jpg"));

  const table = [
    `ffmpeg \`lut3d\` (tetrahedral) applying grade-bridge's ${LUT_SIZE}^3 .cube vs grade-bridge's exact math, on a ${chart.width}x${chart.height} test chart (${(chart.width * chart.height).toLocaleString("en-US")} pixels). Errors in 8-bit levels (1 = 1/255).`,
    "",
    "| Preset | Adapter | Mean error R / G / B | Max error R / G / B | Max vs JS LUT sampler | Result |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Pass rule: mean < ${MAX_MEAN_ERROR} and max <= ${MAX_ABS_ERROR} levels on every channel.`,
    `Negative control: the same LUT written with its axes swapped is off by a mean of ${brokenMean.toFixed(1)} levels (max ${Math.max(...brokenStats.max)}), so the check ${controlCaught ? "does catch a broken file" : "FAILED to catch a broken file"}.`,
  ].join("\n");

  console.log("\n" + table + "\n");
  writeFileSync(join(OUT, "results.md"), table + "\n");
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  console.log(`Images and LUTs saved to ${OUT}/`);

  if (failed) {
    console.error(`${failed} preset(s) FAILED`);
    return 1;
  }
  console.log(`All ${presetFiles.length} presets PASS`);
  return 0;
}

process.exitCode = main();
