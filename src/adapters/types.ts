// An adapter maps one app's sliders to GradeParams. The engine, export, preview
// and CLI never change; a new app is a new adapter file.

import type { GradeParams } from "../core/params.ts";

export interface Control {
  /** Stable id used in presets and share links, e.g. "exposure". */
  key: string;
  /** What the app calls it, e.g. "Exposure". */
  label: string;
  /** Section the control lives in inside the app, e.g. "Light". */
  group: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Shown after the value, e.g. "EV" or "°". */
  unit?: string;
  /** "hue" draws a rainbow track in the UI. */
  kind?: "hue";
}

export type ControlValues = Record<string, number>;

export interface Adapter {
  id: string;
  name: string;
  description: string;
  controls: Control[];
  toParams(values: ControlValues): GradeParams;
}

export function defaultValues(adapter: Adapter): ControlValues {
  return Object.fromEntries(adapter.controls.map((c) => [c.key, c.default]));
}

/** Fills defaults, clamps to range, and reports unknown keys (usually a typo in a preset). */
export function resolveValues(adapter: Adapter, partial: ControlValues): { values: ControlValues; unknown: string[] } {
  const values = defaultValues(adapter);
  const unknown: string[] = [];
  for (const [key, raw] of Object.entries(partial)) {
    const control = adapter.controls.find((c) => c.key === key);
    if (!control) {
      unknown.push(key);
      continue;
    }
    const v = Number(raw);
    if (Number.isFinite(v)) values[key] = Math.min(control.max, Math.max(control.min, v));
  }
  return { values, unknown };
}
