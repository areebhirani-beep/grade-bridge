// Draws whatever controls the adapter lists; the UI has no app-specific code.

import type { Adapter, Control, ControlValues } from "../adapters/index.ts";

export interface PanelCallbacks {
  /** `final` is true when a drag ends or a value is typed. */
  onChange(key: string, value: number, final: boolean): void;
}

const decimals = (step: number) => (step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step))));

export function formatValue(c: Control, v: number): string {
  const s = v.toFixed(decimals(c.step));
  const signed = c.min < 0 && v > 0 ? `+${s}` : s;
  return signed;
}

export class Panel {
  private rows = new Map<string, { range: HTMLInputElement; number: HTMLInputElement; row: HTMLElement; control: Control }>();

  private root: HTMLElement;
  private callbacks: PanelCallbacks;

  constructor(root: HTMLElement, callbacks: PanelCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
  }

  render(adapter: Adapter, values: ControlValues): void {
    this.root.replaceChildren();
    this.rows.clear();

    const groups = new Map<string, Control[]>();
    for (const c of adapter.controls) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);

    for (const [group, controls] of groups) {
      const section = document.createElement("details");
      section.className = "group";
      section.open = true;
      const summary = document.createElement("summary");
      summary.innerHTML = `<span class="group-name"></span><button type="button" class="group-reset" title="Reset ${group}">Reset</button>`;
      summary.querySelector(".group-name")!.textContent = group;
      summary.querySelector("button")!.addEventListener("click", (e) => {
        e.preventDefault();
        for (const c of controls) this.callbacks.onChange(c.key, c.default, true);
      });
      section.append(summary);

      for (const c of controls) section.append(this.row(adapter.id, c, values[c.key]));
      this.root.append(section);
    }
  }

  sync(values: ControlValues): void {
    for (const [key, { range, number, row, control }] of this.rows) {
      const v = values[key];
      if (document.activeElement !== number) number.value = formatValue(control, v);
      range.value = String(v);
      row.classList.toggle("modified", v !== control.default);
      this.paintFill(range, control, v);
    }
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

    const number = document.createElement("input");
    number.type = "text";
    number.inputMode = "decimal";
    number.className = "value";
    number.setAttribute("aria-label", `${c.group} ${c.label} value`);
    number.spellcheck = false;

    const unit = document.createElement("span");
    unit.className = "unit";
    unit.textContent = c.unit ?? "";

    const range = document.createElement("input");
    range.type = "range";
    range.id = id;
    range.min = String(c.min);
    range.max = String(c.max);
    range.step = String(c.step);
    range.value = String(value);
    range.setAttribute("aria-label", `${c.group} ${c.label}`);

    const commitNumber = () => {
      const v = Number(number.value.replace(/[^\d.+-]/g, ""));
      const clamped = Number.isFinite(v) ? Math.min(c.max, Math.max(c.min, v)) : c.default;
      this.callbacks.onChange(c.key, clamped, true);
      number.value = formatValue(c, clamped);
    };

    range.addEventListener("input", () => this.callbacks.onChange(c.key, Number(range.value), false));
    range.addEventListener("change", () => this.callbacks.onChange(c.key, Number(range.value), true));
    number.addEventListener("change", commitNumber);
    number.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commitNumber();
        number.blur();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const dir = e.key === "ArrowUp" ? 1 : -1;
        const step = c.step * (e.shiftKey ? 10 : 1);
        const v = Math.min(c.max, Math.max(c.min, Number(range.value) + dir * step));
        this.callbacks.onChange(c.key, v, true);
      } else if (e.key === "Escape") {
        number.value = formatValue(c, Number(range.value));
        number.blur();
      }
    });
    const reset = () => this.callbacks.onChange(c.key, c.default, true);
    label.addEventListener("dblclick", reset);
    range.addEventListener("dblclick", reset);

    const head = document.createElement("div");
    head.className = "control-head";
    const valueWrap = document.createElement("span");
    valueWrap.className = "value-wrap";
    valueWrap.append(number, unit);
    head.append(label, valueWrap);
    row.append(head, range);

    this.rows.set(c.key, { range, number, row, control: c });
    number.value = formatValue(c, value);
    row.classList.toggle("modified", value !== c.default);
    this.paintFill(range, c, value);
    return row;
  }

  // Fill the track from the neutral value to the current one.
  private paintFill(range: HTMLInputElement, c: Control, v: number): void {
    if (c.kind === "hue") {
      range.style.setProperty("--thumb", `hsl(${v} 85% 60%)`);
      return;
    }
    const pos = (x: number) => ((x - c.min) / (c.max - c.min)) * 100;
    const a = pos(Math.min(v, c.default));
    const b = pos(Math.max(v, c.default));
    range.style.setProperty("--fill-from", `${a}%`);
    range.style.setProperty("--fill-to", `${b}%`);
  }
}
