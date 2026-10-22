// slider change -> adapter.toParams -> buildLut -> GPU 3D texture -> preview
// Export        -> the same LUT     -> .cube text -> download

import "./styles.css";
import { ADAPTERS, defaultValues, getAdapter, presetToParams, type Adapter, type ControlValues, type Preset } from "../adapters/index.ts";
import { parseCube, serializeCube, type CubeFile } from "../core/cube.ts";
import { buildLut } from "../core/lut.ts";
import { Panel } from "./panel.ts";
import { Renderer } from "./renderer.ts";
import { decodeHash, encodeHash } from "./share.ts";

const PRESETS: { id: string; preset: Preset }[] = Object.entries(
  import.meta.glob<Preset>("../../presets/*.json", { eager: true, import: "default" }),
)
  .map(([path, preset]) => ({ id: path.split("/").pop()!.replace(/\.json$/, ""), preset }))
  .sort((a, b) => a.preset.name.localeCompare(b.preset.name));

const CHART_URL = `${import.meta.env.BASE_URL}test-chart.png`;
const PREVIEW_LUT_SIZE = 33;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  adapter: ADAPTERS[0] as Adapter,
  values: defaultValues(ADAPTERS[0]),
  presetId: "" as string,
  imported: null as (CubeFile & { fileName: string }) | null,
  media: null as HTMLImageElement | HTMLVideoElement | null,
  lastBuildMs: 0,
};

let renderer: Renderer | null = null;
try {
  renderer = new Renderer($<HTMLCanvasElement>("canvas"));
} catch (err) {
  const fb = $("fallback");
  fb.hidden = false;
  fb.textContent = `Live preview needs WebGL2, which this browser does not provide (${(err as Error).message}). Export still works.`;
}

let rebuildQueued = false;
function scheduleRebuild(): void {
  // One rebuild per frame however many input events arrive; a 33^3 build is a few ms.
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    rebuildQueued = false;
    rebuild();
  });
}

function rebuild(): void {
  if (state.imported) {
    const lut = state.imported;
    renderer?.setLut(lut.data, lut.size, lut.domainMin, lut.domainMax);
  } else {
    const t0 = performance.now();
    const data = buildLut(state.adapter.toParams(state.values), PREVIEW_LUT_SIZE);
    state.lastBuildMs = performance.now() - t0;
    renderer?.setLut(data, PREVIEW_LUT_SIZE);
  }
  draw();
  updateStatus();
}

function draw(): void {
  if (!renderer || !state.media) return;
  if (state.media instanceof HTMLVideoElement && state.media.readyState >= 2) renderer.setSource(state.media);
  renderer.draw();
}

function updateStatus(): void {
  const status = $("status");
  if (state.imported) {
    status.textContent = `Viewing ${state.imported.fileName} · ${state.imported.size}³`;
    return;
  }
  status.innerHTML = `<span class="dot"></span>Preview = export · LUT ${PREVIEW_LUT_SIZE}³ built in ${state.lastBuildMs.toFixed(1)} ms`;
}

function layoutCanvas(): void {
  const media = state.media;
  if (!media) return;
  const w = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const h = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
  if (!w || !h) return;
  const stage = $("stage");
  const box = stage.getBoundingClientRect();
  const scale = Math.min(box.width / w, box.height / h);
  const cssW = Math.max(1, Math.floor(w * scale));
  const cssH = Math.max(1, Math.floor(h * scale));
  const canvas = $<HTMLCanvasElement>("canvas");
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.min(w, Math.round(cssW * dpr));
  canvas.height = Math.min(h, Math.round(cssH * dpr));
  stage.style.setProperty("--img-w", `${cssW}px`);
  stage.style.setProperty("--img-h", `${cssH}px`);
  positionSplit();
  draw();
}

function stopVideo(): void {
  if (state.media instanceof HTMLVideoElement) {
    state.media.pause();
    URL.revokeObjectURL(state.media.src);
  }
  $("play-btn").hidden = true;
}

function loadImage(url: string, revoke = false): Promise<void> {
  $("chart-hint").hidden = url !== CHART_URL;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      stopVideo();
      state.media = img;
      renderer?.setSource(img);
      layoutCanvas();
      if (revoke) URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => reject(new Error("Could not read that image."));
    img.src = url;
  });
}

function loadVideo(file: File): void {
  stopVideo();
  $("chart-hint").hidden = true;
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.src = URL.createObjectURL(file);
  video.addEventListener("loadeddata", () => {
    state.media = video;
    layoutCanvas();
    void video.play();
    $("play-btn").hidden = false;
    $("play-btn").textContent = "Pause";
    const tick = () => {
      if (state.media !== video) return;
      draw();
      if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    tick();
  }, { once: true });
  video.addEventListener("error", () => toast("Could not play that video in this browser."), { once: true });
}

async function openFile(file: File): Promise<void> {
  if (/\.cube$/i.test(file.name)) return importCube(file);
  if (file.type.startsWith("video/")) return loadVideo(file);
  if (file.type.startsWith("image/")) {
    try {
      await loadImage(URL.createObjectURL(file), true);
    } catch (e) {
      toast((e as Error).message);
    }
    return;
  }
  toast("Drop an image, a video, or a .cube file.");
}

const panel = new Panel($("controls"), {
  onChange(key, value, final) {
    if (state.imported) closeImported(false);
    state.values = { ...state.values, [key]: value };
    state.presetId = "";
    panel.sync(state.values);
    syncPresetSelect();
    scheduleRebuild();
    if (final) writeHash();
    else writeHashSoon();
  },
});

function setAdapter(adapter: Adapter, values?: ControlValues): void {
  state.adapter = adapter;
  state.values = values ?? defaultValues(adapter);
  $<HTMLSelectElement>("adapter-select").value = adapter.id;
  $("adapter-desc").textContent = adapter.description;
  panel.render(adapter, state.values);
  scheduleRebuild();
}

function applyPreset(id: string): void {
  const entry = PRESETS.find((p) => p.id === id);
  if (!entry) return;
  if (state.imported) closeImported(false);
  const { adapter, values } = presetToParams(entry.preset);
  if (adapter !== state.adapter) setAdapter(adapter, values);
  state.values = values;
  state.presetId = id;
  panel.sync(values);
  syncPresetSelect();
  scheduleRebuild();
  writeHash();
}

function resetAll(): void {
  state.values = defaultValues(state.adapter);
  state.presetId = "";
  panel.sync(state.values);
  syncPresetSelect();
  scheduleRebuild();
  writeHash();
}

function syncPresetSelect(): void {
  const select = $<HTMLSelectElement>("preset-select");
  const isDefault = state.adapter.controls.every((c) => state.values[c.key] === c.default);
  select.value = state.presetId || (isDefault ? "none" : "custom");
}

let hashTimer = 0;
function writeHash(): void {
  clearTimeout(hashTimer);
  history.replaceState(null, "", encodeHash(state.adapter, state.values) + (state.presetId ? `&look=${state.presetId}` : ""));
}
function writeHashSoon(): void {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(writeHash, 200);
}
function readHash(): boolean {
  const decoded = decodeHash(location.hash);
  if (!decoded) return false;
  setAdapter(decoded.adapter, decoded.values);
  const look = new URLSearchParams(location.hash.slice(1)).get("look") ?? "";
  state.presetId = PRESETS.some((p) => p.id === look) ? look : "";
  syncPresetSelect();
  return true;
}

async function copyLink(): Promise<void> {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied. Anyone who opens it sees this exact grade.");
  } catch {
    toast("Copy the address bar: the grade is in the link.");
  }
}

function lookTitle(): string {
  const preset = PRESETS.find((p) => p.id === state.presetId);
  return preset ? preset.preset.name : `Custom look (${state.adapter.name})`;
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCube(): void {
  if (state.imported) {
    download(state.imported.fileName, serializeCube(state.imported, state.imported.title || state.imported.fileName));
    return;
  }
  const size = Number($<HTMLSelectElement>("size-select").value);
  const t0 = performance.now();
  const data = buildLut(state.adapter.toParams(state.values), size);
  const ms = performance.now() - t0;
  const title = lookTitle();
  const fileName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "look"}-${size}.cube`;
  download(fileName, serializeCube({ size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }, title));
  toast(`Exported ${fileName} (${size}³, ${ms.toFixed(0)} ms). Load it in Resolve, Premiere, Final Cut, CapCut, OBS or Photoshop.`);
}

async function importCube(file: File): Promise<void> {
  try {
    const cube = parseCube(await file.text());
    state.imported = { ...cube, fileName: file.name };
    $("imported-banner").hidden = false;
    $("imported-name").textContent = cube.title || file.name;
    $("imported-meta").textContent = `${file.name} · ${cube.size}³ · moving any slider returns to your grade`;
    panel.setDisabled(true);
    rebuild();
  } catch (e) {
    toast(`Could not read ${file.name}: ${(e as Error).message}`);
  }
}

function closeImported(redraw = true): void {
  state.imported = null;
  $("imported-banner").hidden = true;
  panel.setDisabled(false);
  if (redraw) rebuild();
}

function positionSplit(): void {
  if (!renderer) return;
  const pct = renderer.split * 100;
  const split = $("split");
  split.style.left = `calc(50% - var(--img-w) / 2 + var(--img-w) * ${renderer.split})`;
  split.setAttribute("aria-valuenow", pct.toFixed(0));
  const on = renderer.compare;
  split.hidden = !on;
  $("tag-before").hidden = !on || renderer.split < 0.08;
  $("tag-after").hidden = !on || renderer.split > 0.92;
  $("compare-btn").setAttribute("aria-pressed", String(on));
}

function setSplit(x: number): void {
  if (!renderer) return;
  renderer.split = Math.min(1, Math.max(0, x));
  positionSplit();
  draw();
}

function toggleCompare(): void {
  if (!renderer) return;
  renderer.compare = !renderer.compare;
  positionSplit();
  draw();
}

function wireSplit(): void {
  const canvas = $<HTMLCanvasElement>("canvas");
  const split = $("split");
  let dragging = false;
  const move = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    setSplit((e.clientX - r.left) / r.width);
  };
  const start = (e: PointerEvent) => {
    if (!renderer?.compare) return;
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    move(e);
  };
  for (const el of [canvas, split]) {
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointermove", (e) => dragging && move(e));
    el.addEventListener("pointerup", () => (dragging = false));
    el.addEventListener("pointercancel", () => (dragging = false));
  }
  split.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") setSplit((renderer?.split ?? 0.5) - step);
    else if (e.key === "ArrowRight") setSplit((renderer?.split ?? 0.5) + step);
    else if (e.key === "Home") setSplit(0);
    else if (e.key === "End") setSplit(1);
    else return;
    e.preventDefault();
  });
}

let toastTimer = 0;
function toast(message: string): void {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 3200);
}

function togglePlay(): void {
  const v = state.media;
  if (!(v instanceof HTMLVideoElement)) return;
  if (v.paused) void v.play();
  else v.pause();
  $("play-btn").textContent = v.paused ? "Play" : "Pause";
}

function wireDropZone(): void {
  const drop = $("drop");
  let depth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    depth++;
    drop.hidden = false;
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) drop.hidden = true;
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    drop.hidden = true;
    const file = e.dataTransfer?.files[0];
    if (file) void openFile(file);
  });
}

function wireKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    const typing = t instanceof HTMLInputElement && t.type !== "range";
    if (typing || t instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($<HTMLDialogElement>("help").open) return;
    const k = e.key;
    if (k === "b" || k === "B") toggleCompare();
    else if (k === "e" || k === "E") exportCube();
    else if (k === "i" || k === "I") $("cube-input").click();
    else if (k === "o" || k === "O") $("media-input").click();
    else if (k === "l" || k === "L") void copyLink();
    else if (k === "R" && e.shiftKey) resetAll();
    else if (k === "?") $<HTMLDialogElement>("help").showModal();
    else if (k === " " && state.media instanceof HTMLVideoElement && !(t instanceof HTMLButtonElement)) togglePlay();
    else return;
    e.preventDefault();
  });
}

function fillSelects(): void {
  const adapterSelect = $<HTMLSelectElement>("adapter-select");
  for (const a of ADAPTERS) adapterSelect.append(new Option(a.name, a.id));
  adapterSelect.addEventListener("change", () => {
    setAdapter(getAdapter(adapterSelect.value));
    state.presetId = "";
    syncPresetSelect();
    writeHash();
    toast(`Switched to ${state.adapter.name}. Controls reset to neutral.`);
  });

  const presetSelect = $<HTMLSelectElement>("preset-select");
  presetSelect.append(new Option("No look", "none"));
  const custom = new Option("Custom", "custom");
  custom.disabled = true;
  presetSelect.append(custom);
  for (const { id, preset } of PRESETS) {
    const opt = new Option(preset.name, id);
    opt.title = preset.description ?? "";
    presetSelect.append(opt);
  }
  presetSelect.addEventListener("change", () => {
    if (presetSelect.value === "none") resetAll();
    else applyPreset(presetSelect.value);
  });
}

function boot(): void {
  fillSelects();
  if (!readHash()) setAdapter(state.adapter);
  syncPresetSelect();

  $("export-btn").addEventListener("click", exportCube);
  $("import-btn").addEventListener("click", () => $("cube-input").click());
  $("share-btn").addEventListener("click", () => void copyLink());
  $("open-btn").addEventListener("click", () => $("media-input").click());
  $("sample-btn").addEventListener("click", () => void loadImage(CHART_URL));
  $("compare-btn").addEventListener("click", toggleCompare);
  $("play-btn").addEventListener("click", togglePlay);
  $("reset-btn").addEventListener("click", resetAll);
  $("help-btn").addEventListener("click", () => $<HTMLDialogElement>("help").showModal());
  $("imported-close").addEventListener("click", () => closeImported());
  $<HTMLInputElement>("media-input").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files?.[0]) void openFile(input.files[0]);
    input.value = "";
  });
  $<HTMLInputElement>("cube-input").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files?.[0]) void importCube(input.files[0]);
    input.value = "";
  });
  window.addEventListener("hashchange", () => readHash());

  wireSplit();
  wireDropZone();
  wireKeyboard();
  new ResizeObserver(layoutCanvas).observe($("stage"));

  rebuild();
  loadImage(CHART_URL).catch(() => toast("Could not load the test chart. Drop your own image."));
}

boot();
