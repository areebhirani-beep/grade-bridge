#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isPreset, presetToParams } from "./adapters/index.ts";
import { serializeCube } from "./core/cube.ts";
import { LUT_SIZES, toLut3D } from "./core/lut.ts";

const HELP = `grade-bridge: export a color grade as a 3D LUT (.cube)

Usage
  grade-bridge export <preset.json> -o <look.cube> [--size 33|65] [--adapter flick]

Options
  -o, --out       Output .cube path (default: <preset name>.cube)
  -s, --size      Grid size, 33 (default) or 65
  -a, --adapter   Adapter for the preset's values: flick, generic, primaries
                  (default: the preset's "adapter" field, else flick)
  -h, --help      Show this help

The .cube loads in DaVinci Resolve, Premiere Pro (Lumetri), Final Cut Pro
(Custom LUT effect), CapCut, OBS (Apply LUT filter) and Photoshop (Color Lookup).`;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "look";
}

function run(argv: string[]): number {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      size: { type: "string", short: "s", default: "33" },
      adapter: { type: "string", short: "a" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, presetPath] = positionals;

  if (opts.help || !command) {
    console.log(HELP);
    return command || opts.help ? 0 : 1;
  }

  if (command !== "export") throw new Error(`Unknown command "${command}". Try --help.`);
  if (!presetPath) throw new Error("export needs a preset file, e.g. grade-bridge export presets/warm-film.json -o warm.cube");

  const size = Number(opts.size);
  if (!(LUT_SIZES as readonly number[]).includes(size)) throw new Error(`--size must be one of ${LUT_SIZES.join(", ")}, got "${opts.size}"`);

  const preset: unknown = JSON.parse(readFileSync(presetPath, "utf8"));
  if (!isPreset(preset)) throw new Error(`${presetPath} is not a preset: it needs "name" and "values"`);

  const { params, adapter } = presetToParams(preset, opts.adapter);
  const started = performance.now();
  const lut = toLut3D(params, size);
  const ms = performance.now() - started;

  const out = opts.out ?? `${slug(preset.name)}.cube`;
  writeFileSync(out, serializeCube(lut, preset.name));
  console.log(`Wrote ${out}  (${preset.name}, ${adapter.id} adapter, ${size}^3 = ${size ** 3} entries, built in ${ms.toFixed(1)} ms)`);
  return 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  console.error(`grade-bridge: ${(err as Error).message}`);
  process.exitCode = 1;
}
