// The grade lives in the URL hash, e.g. #adapter=flick&contrast=22. Only
// non-default values are written. Nothing is uploaded.

import { getAdapter, resolveValues, type Adapter, type ControlValues } from "../adapters/index.ts";

export function encodeHash(adapter: Adapter, values: ControlValues): string {
  const params = new URLSearchParams({ adapter: adapter.id });
  for (const c of adapter.controls) {
    const v = values[c.key];
    if (v !== c.default) params.set(c.key, String(Number(v.toFixed(4))));
  }
  return "#" + params.toString();
}

export function decodeHash(hash: string): { adapter: Adapter; values: ControlValues } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const id = params.get("adapter");
  if (!id) return null;
  try {
    const adapter = getAdapter(id);
    const partial: ControlValues = {};
    params.forEach((v, k) => {
      if (k !== "adapter") partial[k] = Number(v);
    });
    return { adapter, values: resolveValues(adapter, partial).values };
  } catch {
    return null;
  }
}
