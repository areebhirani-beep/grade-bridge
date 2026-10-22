// Checks an exported .cube in an independent pipeline: ffmpeg's lut3d filter
// reads our file and grades a test chart; we grade the same chart with the exact
// math and compare. A wrong axis order, domain or grid would be tens of levels
// off, not ~1. A negative control proves the comparison can fail.
// Run: npm run verify

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPreset, presetToParams } from "../src/adapters/index.ts";
import { serializeCube } from "../src/core/cube.ts";
import { sampleLut, toLut3D } from "../src/core/lut.ts";
import type { RGB } from "../src/core/params.ts";
import { compileGrade } from "../src/core/pipeline.ts";
import { hasFfmpeg, hstack, readImage, writeImage, type RgbImage } from "./image-io.ts";
import { makeTestChart } from "./test-chart.ts";

const OUT = "verify-out";
const LUT_SIZE = 33;
/** Pass/fail limits, in 8-bit levels (1 level = 1/255). */
const MAX_MEAN_ERROR = 1.5;
const MAX_ABS_ERROR = 6;
/** A deliberately broken .cube must be at least this far off, or the check is not sensitive enough. */
const MIN_BROKEN_ERROR = 5;

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

  const chart = makeTestChart(768, 512);
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

    const lut = toLut3D(params, LUT_SIZE);
    const cubePath = join(OUT, "luts", `${id}.cube`);
    writeFileSync(cubePath, serializeCube(lut, preset.name));

    // ffmpeg's default interpolation is tetrahedral, as in most editors.
    const viaFfmpeg = readImage(chartPath, chart.width, chart.height, `lut3d=file=${cubePath}`);
    const grade = compileGrade(params);
    const viaMath = gradeInJs(chart, (rgb) => {
      const out: RGB = [0, 0, 0];
      grade(rgb[0], rgb[1], rgb[2], out, 0);
      return out;
    });
    const viaJsLut = gradeInJs(chart, (rgb) => sampleLut(lut, rgb));

    const vsMath = compare(viaFfmpeg, viaMath);
    const vsJsLut = compare(viaFfmpeg, viaJsLut);
    const worstMean = Math.max(...vsMath.mean);
    const worstMax = Math.max(...vsMath.max);
    const pass = worstMean < MAX_MEAN_ERROR && worstMax <= MAX_ABS_ERROR;
    if (!pass) failed++;

    // Demo image: original | ffmpeg with our .cube | our exact math.
    writeImage(hstack([chart, viaFfmpeg, viaMath]), join(OUT, `${id}-chart.png`));

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
