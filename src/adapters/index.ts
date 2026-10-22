/** The adapter registry, plus presets (named looks written in an adapter's vocabulary). */

import { flick } from "./flick.ts";
import { generic } from "./generic.ts";
import { primaries } from "./primaries.ts";
import { resolveValues, type Adapter, type ControlValues } from "./types.ts";
import type { GradeParams } from "../core/params.ts";

export const ADAPTERS: Adapter[] = [flick, generic, primaries];

export function getAdapter(id: string): Adapter {
  const adapter = ADAPTERS.find((a) => a.id === id);
  if (!adapter) throw new Error(`Unknown adapter "${id}". Available: ${ADAPTERS.map((a) => a.id).join(", ")}`);
  return adapter;
}

export interface Preset {
  name: string;
  description?: string;
  /** Which adapter's control names `values` uses. Defaults to "flick". */
  adapter?: string;
  values: ControlValues;
}

export function isPreset(x: unknown): x is Preset {
  const p = x as Preset;
  return !!p && typeof p.name === "string" && typeof p.values === "object" && p.values !== null;
}

/** Turn a preset into GradeParams. Throws on keys the adapter does not know, so typos never pass silently. */
export function presetToParams(preset: Preset, adapterId?: string): { params: GradeParams; adapter: Adapter; values: ControlValues } {
  const adapter = getAdapter(adapterId ?? preset.adapter ?? "flick");
  const { values, unknown } = resolveValues(adapter, preset.values);
  if (unknown.length) throw new Error(`Preset "${preset.name}" uses controls the "${adapter.id}" adapter does not have: ${unknown.join(", ")}`);
  return { params: adapter.toParams(values), adapter, values };
}

export type { Adapter, Control, ControlValues } from "./types.ts";
export { defaultValues, resolveValues } from "./types.ts";
