// Draws whatever controls the adapter lists; the UI has no app-specific code.
// Each row: label | slider | value field | unit.
//   Drag the value field sideways to scrub it (Shift = 10x, Alt = 1/10).
//   Click or double-click the value to type. Up/Down nudge while typing.
//   Double-click the label or the slider to reset that control.

import type { Adapter, Control, ControlValues } from "../adapters/index.ts";

export interface PanelCallbacks {
  /** `final` is true when a drag ends or a value is typed. */
  onChange(key: string, value: number, final: boolean): void;
}

const decimals = (step: number) => (step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step))));

export function formatValue(c: Pick<Control, "step" | "min">, v: number): string {
  const s = v.toFixed(decimals(c.step));
  return c.min < 0 && v > 0 ? `+${s}` : s;
}

const snap = (c: Control, v: number) => {
  const k = Math.round((v - c.min) / c.step);
  const out = c.min + k * c.step;
  return Number(Math.min(c.max, Math.max(c.min, out)).toFixed(decimals(c.step)));
};

/**
 * A numeric field that scrubs on horizontal drag and turns into a text box on
 * click. Shared by the control rows and the Intensity row.
 */
export function scrubField(
  input: HTMLInputElement,
  c: Control,
  get: () => number,
  set: (v: number, final: boolean) => void,
): void {
  input.type = "text";
  input.inputMode = "decimal";
  input.spellcheck = false;
  input.readOnly = true;
  input.className = "value";

  let startX = 0;
  let startV = 0;
  let moved = false;
  let pointer = -1;

  const edit = () => {
    input.readOnly = false;
    input.classList.add("editing");
    input.focus();
    input.select();
  };
  const endEdit = (commit: boolean) => {
    if (input.readOnly) return;
    if (commit) {
      const v = Number(input.value.replace(/[^\d.+-]/g, ""));
      set(Number.isFinite(v) && input.value.trim() !== "" ? snap(c, v) : get(), true);
    }
    input.readOnly = true;
    input.classList.remove("editing");
    input.value = formatValue(c, get());
  };

  input.addEventListener("pointerdown", (e) => {
    if (!input.readOnly || e.button !== 0) return;
    e.preventDefault();
    pointer = e.pointerId;
    input.setPointerCapture(pointer);
    startX = e.clientX;
    startV = get();
    moved = false;
  });
  input.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointer) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) < 3) return;
    if (!moved) document.body.classList.add("scrubbing");
    moved = true;
    // About 200 px of drag sweeps the whole range.
    const perPx = ((c.max - c.min) / 200) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    set(snap(c, startV + dx * perPx), false);
  });
  const up = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = -1;
    document.body.classList.remove("scrubbing");
    if (moved) set(get(), true);
    else edit();
  };
  input.addEventListener("pointerup", up);
  input.addEventListener("pointercancel", up);
  input.addEventListener("dblclick", edit);
  input.addEventListener("blur", () => endEdit(true));
  input.addEventListener("keydown", (e) => {
    if (input.readOnly) {
      if (e.key === "Enter") {
        e.preventDefault();
        edit();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      endEdit(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      endEdit(false);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? 1 : -1;
      const v = snap(c, get() + dir * c.step * (e.shiftKey ? 10 : 1));
      set(v, true);
      input.value = formatValue(c, v);
      input.select();
    }
    e.stopPropagation();
  });
}

interface Row {
  range: HTMLInputElement;
  number: HTMLInputElement;
  row: HTMLElement;
  control: Control;
}

export class Panel {
  private rows = new Map<string, Row>();
  private groups: { el: HTMLElement; controls: Control[] }[] = [];
  private values: ControlValues = {};
  private root: HTMLElement;
  private callbacks: PanelCallbacks;

  constructor(root: HTMLElement, callbacks: PanelCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
  }

  render(adapter: Adapter, values: ControlValues): void {
    this.root.replaceChildren();
    this.rows.clear();
    this.groups = [];
    this.values = { ...values };

    const groups = new Map<string, Control[]>();
    for (const c of adapter.controls) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);

    for (const [group, controls] of groups) {
      const section = document.createElement("details");
      section.className = "group";
      section.open = true;
      const summary = document.createElement("summary");
      const name = document.createElement("span");
      name.className = "group-name";
      name.textContent = group;
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "group-reset";
      reset.textContent = "Reset";
      reset.title = `Reset ${group}`;
      reset.addEventListener("click", (e) => {
        e.preventDefault();
        for (const c of controls) this.callbacks.onChange(c.key, c.default, true);
      });
      summary.append(name, reset);
      section.append(summary);
      for (const c of controls) section.append(this.row(adapter.id, c, values[c.key]));
      this.root.append(section);
      this.groups.push({ el: section, controls });
    }
    this.sync(values);
  }

  sync(values: ControlValues): void {
    this.values = { ...values };
    for (const [key, { range, number, row, control }] of this.rows) {
      const v = values[key];
      if (number.readOnly) number.value = formatValue(control, v);
      range.value = String(v);
      row.classList.toggle("modified", v !== control.default);
      paintFill(range, control, v);
    }
    for (const g of this.groups) g.el.classList.toggle("modified", g.controls.some((c) => values[c.key] !== c.default));
  }

  setDisabled(disabled: boolean): void {
    this.root.classList.toggle("disabled", disabled);
  }

  private row(adapterId: string, c: Control, value: number): HTMLElement {
    const id = `ctl-${adapterId}-${c.key}`;
    const row = document.createElement("div");
    row.className = "control" + (c.kind === "hue" ? " hue" : "");

    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = c.label;
    label.title = "Double-click to reset";

    const range = document.createElement("input");
    range.type = "range";
    range.id = id;
    range.min = String(c.min);
    range.max = String(c.max);
    range.step = String(c.step);
    range.value = String(value);
    range.setAttribute("aria-label", `${c.group} ${c.label}`);

    const number = document.createElement("input");
    scrubField(number, c, () => this.values[c.key], (v, final) => this.callbacks.onChange(c.key, v, final));
    number.setAttribute("aria-label", `${c.group} ${c.label} value`);
    number.title = "Drag to scrub, click to type";

    const unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = c.unit ?? "";

    range.addEventListener("input", () => this.callbacks.onChange(c.key, Number(range.value), false));
    range.addEventListener("change", () => this.callbacks.onChange(c.key, Number(range.value), true));
    const reset = () => this.callbacks.onChange(c.key, c.default, true);
    label.addEventListener("dblclick", reset);
    range.addEventListener("dblclick", reset);

    row.append(label, range, number, unit);
    this.rows.set(c.key, { range, number, row, control: c });
    return row;
  }
}

/** Fills the track from the neutral value to the current one. */
export function paintFill(range: HTMLInputElement, c: Pick<Control, "min" | "max" | "default" | "kind">, v: number): void {
  if (c.kind === "hue") {
    range.style.setProperty("--thumb", `hsl(${v} 70% 58%)`);
    return;
  }
  const pos = (x: number) => ((x - c.min) / (c.max - c.min)) * 100;
  range.style.setProperty("--fill-from", `${pos(Math.min(v, c.default))}%`);
  range.style.setProperty("--fill-to", `${pos(Math.max(v, c.default))}%`);
}
