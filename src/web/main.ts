// slider change -> adapter.toParams -> buildLut -> GPU 3D texture -> preview (mixed by Intensity in the shader)
// Export        -> the same LUT -> mixWithIdentity(Intensity) -> .cube text -> download
// Looks + scopes -> the same LUTs applied on the CPU to a downscaled copy of the frame

import "./styles.css";
import { ADAPTERS, defaultValues, getAdapter, presetToParams, type Adapter, type Control, type ControlValues, type Preset } from "../adapters/index.ts";
import { parseCube, serializeCube, type CubeFile } from "../core/cube.ts";
import { buildLut, mixWithIdentity } from "../core/lut.ts";
import type { RGB } from "../core/params.ts";
import { applyLutToPixels, grabFrame, mediaSize, type Pixels } from "./frame.ts";
import { Panel, paintFill, scrubField } from "./panel.ts";
import { Renderer, type CompareMode } from "./renderer.ts";
import { ScopeView, type ScopeKind } from "./scopeview.ts";
import { decodeHash, encodeHash } from "./share.ts";

const PRESETS: { id: string; preset: Preset }[] = Object.entries(
  import.meta.glob<Preset>("../../presets/*.json", { eager: true, import: "default" }),
)
  .map(([path, preset]) => ({ id: path.split("/").pop()!.replace(/\.json$/, ""), preset }))
  .sort((a, b) => a.preset.name.localeCompare(b.preset.name));

const CHART_URL = `${import.meta.env.BASE_URL}test-chart.png`;
const PREVIEW_LUT_SIZE = 33;
const THUMB_W = 136;
const THUMB_H = 76;
const SCOPE_W = 640;
const SCOPE_H = 360;
const SCOPE_INTERVAL_MS = 90; // about 11 scope updates a second during playback

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Media = HTMLImageElement | HTMLVideoElement;

const state = {
  adapter: ADAPTERS[0] as Adapter,
  values: defaultValues(ADAPTERS[0]),
  /** Preset whose values are loaded exactly. */
  presetId: "",
  /** Preset the current values started from, for the "Modified" label. */
  basedOn: "",
  imported: null as (CubeFile & { fileName: string }) | null,
  media: null as Media | null,
  mediaName: "",
  intensity: 100,
  exportSize: 33,
  lut: new Float32Array(0) as Float32Array<ArrayBufferLike>,
  lutSize: PREVIEW_LUT_SIZE,
  domainMin: [0, 0, 0] as ArrayLike<number>,
  domainMax: [1, 1, 1] as ArrayLike<number>,
  /** The preview LUT with Intensity baked in; feeds the scopes. */
  mixed: new Float32Array(0) as Float32Array<ArrayBufferLike>,
  lastBuildMs: 0,
  fps: 0,
  loop: true,
  compare: "wipe" as CompareMode,
  scope: "waveform" as ScopeKind,
};

// ---------- Renderer ----------

let renderer: Renderer | null = null;
try {
  renderer = new Renderer($<HTMLCanvasElement>("canvas"));
  renderer.gapColor = [0x15 / 255, 0x15 / 255, 0x15 / 255];
} catch (err) {
  const fb = $("fallback");
  fb.hidden = false;
  fb.textContent = `The live preview needs WebGL2, which this browser does not provide (${(err as Error).message}). Looks, scopes and Export .cube still work.`;
  $("frame").hidden = true;
}

const scopeView = new ScopeView($<HTMLCanvasElement>("scope"));

// ---------- Grade -> LUT ----------

let rebuildQueued = false;
function scheduleRebuild(): void {
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
    state.lut = lut.data;
    state.lutSize = lut.size;
    state.domainMin = lut.domainMin;
    state.domainMax = lut.domainMax;
  } else {
    const t0 = performance.now();
    state.lut = buildLut(state.adapter.toParams(state.values), PREVIEW_LUT_SIZE);
    state.lastBuildMs = performance.now() - t0;
    state.lutSize = PREVIEW_LUT_SIZE;
    state.domainMin = [0, 0, 0];
    state.domainMax = [1, 1, 1];
  }
  renderer?.setLut(state.lut, state.lutSize, state.domainMin, state.domainMax);
  remix();
}

/** Intensity changed (or the LUT did): update shader uniform + the CPU copy for scopes. */
function remix(): void {
  const k = state.intensity / 100;
  if (renderer) renderer.intensity = k;
  state.mixed = mixWithIdentity(state.lut, state.lutSize, k, Array.from(state.domainMin) as RGB, Array.from(state.domainMax) as RGB);
  draw();
  scheduleScopes(true);
  updateStatus();
  updateLookBlock();
}

function draw(): void {
  if (!renderer || !state.media) return;
  renderer.draw();
}

function updateStatus(): void {
  const s = $("status");
  if (state.imported) s.textContent = `Viewing ${state.imported.fileName}, ${state.imported.size}³`;
  else s.textContent = `Preview LUT ${PREVIEW_LUT_SIZE}³ built in ${state.lastBuildMs.toFixed(1)} ms, same data as the export`;
}

// ---------- Looks strip ----------

interface LookTile {
  id: string;
  name: string;
  lut: Float32Array | null; // null = original
  size: number;
  el: HTMLButtonElement;
  canvas: HTMLCanvasElement;
}
const looks: LookTile[] = [];

function makeTile(id: string, name: string, title: string): { el: HTMLButtonElement; canvas: HTMLCanvasElement } {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "look";
  el.setAttribute("role", "option");
  el.dataset.id = id;
  el.title = title;
  const canvas = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(THUMB_W * dpr);
  canvas.height = Math.round(THUMB_H * dpr);
  const label = document.createElement("span");
  label.textContent = name;
  el.append(canvas, label);
  return { el, canvas };
}

function buildLooks(): void {
  const strip = $("looks");
  const add = (id: string, name: string, title: string, lut: Float32Array | null, size: number) => {
    const { el, canvas } = makeTile(id, name, title);
    el.addEventListener("click", () => selectLook(id));
    strip.append(el);
    looks.push({ id, name, lut, size, el, canvas });
  };
  add("none", "Original", "No grade", null, PREVIEW_LUT_SIZE);
  for (const { id, preset } of PRESETS) {
    add(id, preset.name, preset.description ?? preset.name, buildLut(presetToParams(preset).params, PREVIEW_LUT_SIZE), PREVIEW_LUT_SIZE);
  }
}

function syncImportedTile(): void {
  const existing = looks.findIndex((l) => l.id === "imported");
  if (existing >= 0) {
    looks[existing].el.remove();
    looks.splice(existing, 1);
  }
  if (!state.imported) return;
  const cube = state.imported;
  const { el, canvas } = makeTile("imported", cube.fileName, `${cube.title || cube.fileName}, ${cube.size}³`);
  el.classList.add("imported-tile");
  el.addEventListener("click", () => selectLook("imported"));
  $("looks").prepend(el);
  looks.unshift({ id: "imported", name: cube.title || cube.fileName, lut: cube.data, size: cube.size, el, canvas });
  renderThumbs();
}

let thumbSource: Pixels | null = null;
function renderThumbs(): void {
  if (!state.media) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const tw = Math.round(THUMB_W * dpr);
  const th = Math.round(THUMB_H * dpr);
  thumbSource = grabFrame(state.media, tw, th, "cover");
  if (!thumbSource) return;
  for (const look of looks) {
    if (look.canvas.width !== tw || look.canvas.height !== th) {
      look.canvas.width = tw;
      look.canvas.height = th;
    }
    const ctx = look.canvas.getContext("2d")!;
    const data = look.lut
      ? applyLutToPixels(thumbSource, {
          size: look.size,
          data: look.lut,
          domainMin: look.id === "imported" ? state.imported?.domainMin : undefined,
          domainMax: look.id === "imported" ? state.imported?.domainMax : undefined,
        })
      : thumbSource.data;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data), thumbSource.width, thumbSource.height), 0, 0);
  }
}

function activeLookId(): string {
  if (state.imported) return "imported";
  if (state.presetId) return state.presetId;
  return isDefault() ? "none" : "";
}

function syncLooks(): void {
  const active = activeLookId();
  for (const l of looks) {
    const on = l.id === active;
    l.el.classList.toggle("active", on);
    l.el.setAttribute("aria-selected", String(on));
  }
}

function selectLook(id: string): void {
  if (id === "imported") return;
  if (id === "none") {
    if (state.imported) closeImported(false);
    resetAll();
    return;
  }
  applyPreset(id);
}

function stepLook(dir: number): void {
  const ids = looks.map((l) => l.id);
  const current = ids.indexOf(activeLookId() || state.basedOn || "none");
  const next = ids[(current + dir + ids.length) % ids.length];
  selectLook(next);
  looks.find((l) => l.id === next)?.el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

// ---------- Scopes ----------

let scopeQueued = false;
let lastScopeAt = 0;
function scheduleScopes(force = false): void {
  if (scopeQueued) return;
  const now = performance.now();
  if (!force && now - lastScopeAt < SCOPE_INTERVAL_MS) return;
  scopeQueued = true;
  requestAnimationFrame(() => {
    scopeQueued = false;
    lastScopeAt = performance.now();
    renderScopes();
  });
}

function renderScopes(): void {
  if (!state.media) {
    scopeView.draw(null);
    return;
  }
  const px = grabFrame(state.media, SCOPE_W, SCOPE_H, "contain");
  if (!px) return;
  const graded = applyLutToPixels(px, { size: state.lutSize, data: state.mixed, domainMin: state.domainMin, domainMax: state.domainMax }, px.data);
  scopeView.draw({ width: px.width, height: px.height, data: graded });
}

const SCOPE_CAPTIONS: Record<ScopeKind, string> = {
  waveform: "Luma (Rec.709) of the graded frame, left to right as in the picture. 0 to 100 = code 0 to 255.",
  parade: "Red, green and blue of the graded frame, side by side. 0 to 100 = code 0 to 255.",
  vector: "Hue and saturation of the graded frame (Rec.709 Cb/Cr). Boxes are 75% bars; the dashed line is the skin-tone line.",
};

function setScope(kind: ScopeKind): void {
  state.scope = kind;
  scopeView.kind = kind;
  $("scope").classList.toggle("square", kind === "vector");
  setSeg("scope-seg", "scope", kind);
  $("scope-caption").textContent = SCOPE_CAPTIONS[kind];
  renderScopes();
}

// ---------- Segmented controls ----------

function setSeg(id: string, attr: string, value: string): void {
  for (const b of $(id).querySelectorAll<HTMLButtonElement>("button")) {
    const on = b.dataset[attr] === value;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function wireSeg(id: string, attr: string, onPick: (v: string) => void): void {
  const root = $(id);
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b?.dataset[attr]) onPick(b.dataset[attr]!);
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
    const i = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true");
    const next = buttons[(i + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
    onPick(next.dataset[attr]!);
    next.focus();
    e.preventDefault();
    e.stopPropagation();
  });
}

// ---------- Viewer layout + compare ----------

function layoutCanvas(): void {
  const media = state.media;
  if (!media) return;
  const { width: w, height: h } = mediaSize(media);
  if (!w || !h) return;
  const stage = $("stage");
  const box = stage.getBoundingClientRect();
  const pad = 12;
  const availW = Math.max(1, box.width - pad * 2);
  const availH = Math.max(1, box.height - pad * 2);
  const side = state.compare === "side";
  const gapCss = side ? 6 : 0;
  const scale = side ? Math.min((availW - gapCss) / (2 * w), availH / h) : Math.min(availW / w, availH / h);
  const frameW = Math.max(1, Math.floor(w * scale));
  const cssW = side ? frameW * 2 + gapCss : frameW;
  const cssH = Math.max(1, Math.floor(h * scale));
  const canvas = $<HTMLCanvasElement>("canvas");
  const frame = $("frame");
  frame.style.width = `${cssW}px`;
  frame.style.height = `${cssH}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  if (renderer) renderer.gapPx = canvas.width - 2 * Math.round(frameW * dpr);
  frame.style.setProperty("--half", `${frameW}px`);
  syncCompareUi();
  draw();
}

function setCompare(mode: CompareMode): void {
  state.compare = mode;
  if (renderer) renderer.compare = mode;
  setSeg("compare-seg", "mode", mode);
  layoutCanvas();
}

function syncCompareUi(): void {
  const hold = renderer?.holdOriginal ?? false;
  const frame = $("frame");
  frame.dataset.mode = hold ? "hold" : state.compare;
  const wipe = $("wipe");
  const split = renderer?.split ?? 0.5;
  wipe.style.left = `${split * 100}%`;
  wipe.setAttribute("aria-valuenow", (split * 100).toFixed(0));
  const wipeOn = state.compare === "wipe" && !hold;
  wipe.hidden = !wipeOn;
  $("tag-left").hidden = hold || state.compare === "off" || (wipeOn && split < 0.1);
  $("tag-right").hidden = hold || state.compare === "off" || (wipeOn && split > 0.9);
  $("tag-hold").hidden = !hold;
}

function setSplit(x: number): void {
  if (!renderer) return;
  renderer.split = Math.min(1, Math.max(0, x));
  syncCompareUi();
  draw();
}

function setHold(on: boolean): void {
  if (!renderer || renderer.holdOriginal === on) return;
  renderer.holdOriginal = on;
  syncCompareUi();
  draw();
}

function wireWipe(): void {
  const canvas = $<HTMLCanvasElement>("canvas");
  const wipe = $("wipe");
  let dragging = false;
  const move = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    setSplit((e.clientX - r.left) / r.width);
  };
  const start = (e: PointerEvent) => {
    if (state.compare !== "wipe") return;
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    move(e);
  };
  for (const el of [canvas, wipe]) {
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointermove", (e) => dragging && move(e));
    el.addEventListener("pointerup", () => (dragging = false));
    el.addEventListener("pointercancel", () => (dragging = false));
  }
  wipe.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") setSplit((renderer?.split ?? 0.5) - step);
    else if (e.key === "ArrowRight") setSplit((renderer?.split ?? 0.5) + step);
    else if (e.key === "Home") setSplit(0);
    else if (e.key === "End") setSplit(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
}

// ---------- Media ----------

function showEditor(): void {
  if (!$("app").hidden) return;
  $("intro").hidden = true;
  $("app").hidden = false;
  document.body.classList.add("editing");
  requestAnimationFrame(() => {
    layoutCanvas();
    renderScopes();
  });
}

function setMedia(media: Media, name: string): void {
  stopVideo(media);
  state.media = media;
  state.mediaName = name;
  const { width, height } = mediaSize(media);
  renderer?.setSource(media, width, height);
  showEditor();
  $("clip-name").textContent = name;
  $("clip-res").textContent = `${width} × ${height}`;
  const isVideo = media instanceof HTMLVideoElement;
  $("clip-fps").textContent = isVideo ? "fps measuring" : "";
  $("transport-video").hidden = !isVideo;
  $("transport-still").hidden = isVideo;
  layoutCanvas();
  renderThumbs();
  scheduleScopes(true);
}

function stopVideo(next?: Media): void {
  const v = state.media;
  if (v instanceof HTMLVideoElement && v !== next) {
    v.pause();
    URL.revokeObjectURL(v.src);
    v.removeAttribute("src");
    v.load();
  }
}

function loadImage(url: string, name: string, revoke = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      setMedia(img, name);
      if (revoke) URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => reject(new Error(`Could not read ${name} as an image.`));
    img.src = url;
  });
}

function loadVideo(file: File): void {
  const video = document.createElement("video");
  video.muted = true;
  video.loop = state.loop;
  video.playsInline = true;
  video.preload = "auto";
  video.src = URL.createObjectURL(file);
  state.fps = 0;
  fpsSamples.length = 0;
  video.addEventListener(
    "loadeddata",
    () => {
      setMedia(video, file.name);
      const scrubber = $<HTMLInputElement>("scrubber");
      scrubber.max = String(video.duration || 0);
      $("tc-dur").textContent = timecode(video.duration || 0);
      watchVideo(video);
      void video.play().catch(() => syncPlayButton());
    },
    { once: true },
  );
  video.addEventListener(
    "error",
    () => fail(`This browser cannot decode ${file.name}. Try an H.264 MP4 or a WebM.`),
    { once: true },
  );
}

// ---------- Video transport ----------

const fpsSamples: number[] = [];
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];

function noteFrame(mediaTime: number, presented: number, last: { t: number; n: number } | null): void {
  if (!last || presented - last.n !== 1 || mediaTime <= last.t) return;
  fpsSamples.push(1 / (mediaTime - last.t));
  if (fpsSamples.length < 8 || state.fps) return;
  const sorted = [...fpsSamples].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const nearest = COMMON_FPS.reduce((a, b) => (Math.abs(b - median) < Math.abs(a - median) ? b : a));
  const snapped = Math.abs(nearest - median) / nearest < 0.01 ? nearest : undefined;
  state.fps = snapped ?? Math.round(median * 100) / 100;
  $("clip-fps").textContent = `${state.fps} fps`;
  $("tc-dur").textContent = timecode((state.media as HTMLVideoElement).duration || 0);
}

function timecode(t: number): string {
  const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
  const hh = pad(t / 3600);
  const mm = pad((t % 3600) / 60);
  const ss = pad(t % 60);
  if (!state.fps) return `${hh}:${mm}:${ss}.${String(Math.floor((t % 1) * 1000)).padStart(3, "0")}`;
  const nominal = Math.round(state.fps);
  const ff = pad(Math.floor((t % 1) * state.fps + 1e-4) % nominal);
  return `${hh}:${mm}:${ss}:${ff}`;
}

function watchVideo(video: HTMLVideoElement): void {
  let last: { t: number; n: number } | null = null;
  const onFrame = (time: number) => {
    if (state.media !== video) return;
    renderer?.setSource(video, video.videoWidth, video.videoHeight);
    draw();
    scheduleScopes(video.paused);
    syncTransport(time);
  };
  if (typeof video.requestVideoFrameCallback === "function") {
    const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (state.media !== video) return;
      noteFrame(meta.mediaTime, meta.presentedFrames, last);
      last = { t: meta.mediaTime, n: meta.presentedFrames };
      onFrame(meta.mediaTime);
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
  } else {
    const tick = () => {
      if (state.media !== video) return;
      if (!video.paused) onFrame(video.currentTime);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  video.addEventListener("seeked", () => {
    if (state.media !== video) return;
    onFrame(video.currentTime);
    if (video.paused) renderThumbs();
  });
  video.addEventListener("play", syncPlayButton);
  video.addEventListener("pause", () => {
    syncPlayButton();
    if (state.media === video) {
      renderThumbs();
      scheduleScopes(true);
    }
  });
  video.addEventListener("ended", syncPlayButton);
}

let scrubbing = false;
function syncTransport(t: number): void {
  const v = state.media;
  if (!(v instanceof HTMLVideoElement)) return;
  $("tc-now").textContent = timecode(t);
  if (!scrubbing) $<HTMLInputElement>("scrubber").value = String(t);
  paintScrubber();
}

function paintScrubber(): void {
  const s = $<HTMLInputElement>("scrubber");
  const max = Number(s.max) || 1;
  s.style.setProperty("--progress", `${(Number(s.value) / max) * 100}%`);
}

function syncPlayButton(): void {
  const v = state.media;
  const playing = v instanceof HTMLVideoElement && !v.paused;
  const btn = $("play-btn");
  btn.classList.toggle("playing", playing);
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

function togglePlay(): void {
  const v = state.media;
  if (!(v instanceof HTMLVideoElement)) return;
  if (v.paused) {
    if (v.ended || v.currentTime >= v.duration) v.currentTime = 0;
    void v.play();
  } else v.pause();
}

function stepFrames(dir: number, seconds = false): void {
  const v = state.media;
  if (!(v instanceof HTMLVideoElement)) return;
  v.pause();
  const fps = state.fps || 30;
  if (seconds) {
    v.currentTime = Math.min(v.duration, Math.max(0, v.currentTime + dir));
    return;
  }
  // Seek to the middle of the target frame so rounding never lands on its edge.
  const frame = Math.floor(v.currentTime * fps + 1e-4) + dir;
  const maxFrame = Math.max(0, Math.floor(v.duration * fps) - 1);
  v.currentTime = (Math.min(maxFrame, Math.max(0, frame)) + 0.5) / fps;
}

function toggleLoop(): void {
  state.loop = !state.loop;
  $("loop-btn").setAttribute("aria-pressed", String(state.loop));
  if (state.media instanceof HTMLVideoElement) state.media.loop = state.loop;
}

function wireTransport(): void {
  $("play-btn").addEventListener("click", togglePlay);
  $("loop-btn").addEventListener("click", toggleLoop);
  const s = $<HTMLInputElement>("scrubber");
  let resume = false;
  s.addEventListener("pointerdown", () => {
    const v = state.media;
    if (!(v instanceof HTMLVideoElement)) return;
    scrubbing = true;
    resume = !v.paused;
    v.pause();
  });
  s.addEventListener("input", () => {
    const v = state.media;
    if (!(v instanceof HTMLVideoElement)) return;
    v.currentTime = Number(s.value);
    $("tc-now").textContent = timecode(Number(s.value));
    paintScrubber();
  });
  const end = () => {
    if (!scrubbing) return;
    scrubbing = false;
    const v = state.media;
    if (resume && v instanceof HTMLVideoElement) void v.play();
    resume = false;
  };
  s.addEventListener("pointerup", end);
  s.addEventListener("pointercancel", end);
  s.addEventListener("change", end);
}

// ---------- Files ----------

async function openFile(file: File): Promise<void> {
  if (/\.cube$/i.test(file.name)) {
    if (!state.media) await loadImage(CHART_URL, "Test chart").catch(() => undefined);
    return importCube(file);
  }
  if (file.type.startsWith("video/") || /\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name)) return loadVideo(file);
  if (file.type.startsWith("image/")) {
    try {
      await loadImage(URL.createObjectURL(file), file.name, true);
    } catch (e) {
      fail((e as Error).message);
    }
    return;
  }
  fail(`${file.name} is not a photo, a video or a .cube file.`);
}

function fail(message: string): void {
  if ($("app").hidden) {
    const el = $("intro-error");
    el.textContent = message;
    el.hidden = false;
  } else toast(message);
}

// ---------- Controls ----------

const panel = new Panel($("controls"), {
  onChange(key, value, final) {
    if (state.imported) closeImported(false);
    if (state.values[key] === value && !final) return;
    state.values = { ...state.values, [key]: value };
    if (state.presetId) state.basedOn = state.presetId;
    state.presetId = "";
    panel.sync(state.values);
    syncLooks();
    scheduleRebuild();
    if (final) writeHash();
    else writeHashSoon();
  },
});

const isDefault = () => state.adapter.controls.every((c) => state.values[c.key] === c.default);

function setAdapter(adapter: Adapter, values?: ControlValues): void {
  state.adapter = adapter;
  state.values = values ?? defaultValues(adapter);
  $<HTMLSelectElement>("adapter-select").value = adapter.id;
  $<HTMLSelectElement>("adapter-select").title = adapter.description;
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
  state.basedOn = id;
  panel.sync(values);
  syncLooks();
  scheduleRebuild();
  writeHash();
}

function resetAll(): void {
  state.values = defaultValues(state.adapter);
  state.presetId = "";
  state.basedOn = "";
  panel.sync(state.values);
  syncLooks();
  scheduleRebuild();
  writeHash();
}

function lookName(): string {
  if (state.imported) return state.imported.title || state.imported.fileName;
  const id = state.presetId || state.basedOn;
  const preset = PRESETS.find((p) => p.id === id);
  if (preset) return preset.preset.name;
  return isDefault() ? "Original" : "Custom look";
}

function updateLookBlock(): void {
  $("look-name").textContent = lookName();
  let note = "";
  if (!state.imported && !state.presetId && state.basedOn && !isDefault()) note = "Modified";
  $("look-state").textContent = note;
  syncLooks();
}

const INTENSITY: Control = { key: "intensity", label: "Intensity", group: "Look", min: 0, max: 100, step: 1, default: 100, unit: "%" };

function setIntensity(v: number, final: boolean | null): void {
  state.intensity = Math.round(Math.min(100, Math.max(0, v)));
  const range = $<HTMLInputElement>("intensity");
  range.value = String(state.intensity);
  paintFill(range, INTENSITY, state.intensity);
  const field = $<HTMLInputElement>("intensity-value");
  if (field.readOnly) field.value = String(state.intensity);
  $("intensity-row").classList.toggle("modified", state.intensity !== 100);
  remix();
  if (final) writeHash();
  else if (final === false) writeHashSoon();
}

function wireIntensity(): void {
  const range = $<HTMLInputElement>("intensity");
  range.addEventListener("input", () => setIntensity(Number(range.value), false));
  range.addEventListener("change", () => setIntensity(Number(range.value), true));
  range.addEventListener("dblclick", () => setIntensity(100, true));
  $("intensity-row").querySelector("label")!.addEventListener("dblclick", () => setIntensity(100, true));
  scrubField($<HTMLInputElement>("intensity-value"), INTENSITY, () => state.intensity, setIntensity);
  setIntensity(state.intensity, null);
}

// ---------- Share link ----------

let hashTimer = 0;
function writeHash(): void {
  clearTimeout(hashTimer);
  let hash = encodeHash(state.adapter, state.values);
  if (state.presetId) hash += `&look=${state.presetId}`;
  if (state.intensity !== 100) hash += `&mix=${state.intensity}`;
  history.replaceState(null, "", hash);
}
function writeHashSoon(): void {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(writeHash, 200);
}
function readHash(): boolean {
  const decoded = decodeHash(location.hash);
  if (!decoded) return false;
  setAdapter(decoded.adapter, decoded.values);
  const extra = new URLSearchParams(location.hash.slice(1));
  const look = extra.get("look") ?? "";
  state.presetId = PRESETS.some((p) => p.id === look) ? look : "";
  state.basedOn = state.presetId;
  const mix = Number(extra.get("mix"));
  state.intensity = extra.has("mix") && Number.isFinite(mix) ? Math.min(100, Math.max(0, Math.round(mix))) : 100;
  return true;
}

async function copyLink(): Promise<void> {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied. It holds the grade, not your file.");
  } catch {
    toast("Copy the address bar: the grade is in the link.");
  }
}

// ---------- Export ----------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "look";

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** The LUT that Export writes: the full grade at `size`, with Intensity baked in. */
function exportLut(size: number): { size: number; data: Float32Array; domainMin: [number, number, number]; domainMax: [number, number, number] } {
  const k = state.intensity / 100;
  if (state.imported) {
    const { size: s, data, domainMin, domainMax } = state.imported;
    return { size: s, data: mixWithIdentity(data, s, k, domainMin, domainMax), domainMin, domainMax };
  }
  const full = buildLut(state.adapter.toParams(state.values), size);
  return { size, data: mixWithIdentity(full, size, k), domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
}

function exportCube(): void {
  const t0 = performance.now();
  const lut = exportLut(state.exportSize);
  const ms = performance.now() - t0;
  const modified = !state.imported && !state.presetId && !!state.basedOn && !isDefault();
  const base = modified ? `${lookName()}, modified` : lookName();
  const mixed = state.intensity !== 100;
  const title = mixed ? `${base} (Mixed at ${state.intensity}% intensity)` : base;
  const fileName = `${slug(base)}${mixed ? `-${state.intensity}pct` : ""}-${lut.size}.cube`;
  download(fileName, new Blob([serializeCube(lut, title)], { type: "text/plain" }));
  toast(`Exported ${fileName}, ${lut.size}³ in ${ms.toFixed(0)} ms.`);
}

function exportStill(): void {
  if (!renderer || !state.media) {
    toast("Export still needs the WebGL2 preview.");
    return;
  }
  try {
    const { width, height } = mediaSize(state.media);
    renderer.setSource(state.media, width, height);
    // Grade the still with the full-size LUT the .cube export would write.
    const lut = state.imported ?? { size: state.exportSize, data: buildLut(state.adapter.toParams(state.values), state.exportSize), domainMin: [0, 0, 0], domainMax: [1, 1, 1] };
    renderer.setLut(lut.data, lut.size, lut.domainMin, lut.domainMax);
    const img = renderer.renderFullRes();
    renderer.setLut(state.lut, state.lutSize, state.domainMin, state.domainMax);
    draw();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d")!.putImageData(img, 0, 0);
    const v = state.media instanceof HTMLVideoElement ? `-${timecode(state.media.currentTime).replace(/[:.]/g, "")}` : "";
    const name = `${slug(state.mediaName.replace(/\.[^.]+$/, ""))}${v}-${slug(lookName())}${state.intensity !== 100 ? `-${state.intensity}pct` : ""}.png`;
    c.toBlob((blob) => {
      if (!blob) return toast("The browser could not encode the PNG.");
      download(name, blob);
      toast(`Exported ${name}, ${img.width} × ${img.height}.`);
    }, "image/png");
  } catch (e) {
    toast((e as Error).message);
  }
}

function setExportSize(size: number): void {
  state.exportSize = size;
  setSeg("size-seg", "size", String(size));
}

// ---------- Import ----------

async function importCube(file: File): Promise<void> {
  try {
    const cube = parseCube(await file.text());
    state.imported = { ...cube, fileName: file.name };
    $("imported-banner").hidden = false;
    $("imported-meta").textContent = `${file.name}, ${cube.size}³. Moving a control returns to your grade.`;
    panel.setDisabled(true);
    syncImportedTile();
    rebuild();
  } catch (e) {
    fail(`Could not read ${file.name}: ${(e as Error).message}`);
  }
}

function closeImported(redraw = true): void {
  state.imported = null;
  $("imported-banner").hidden = true;
  panel.setDisabled(false);
  syncImportedTile();
  if (redraw) rebuild();
}

// ---------- Chrome: toast, popover, drop, keyboard ----------

let toastTimer = 0;
function toast(message: string): void {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 3400);
}

function wirePopover(): void {
  const btn = $("load-btn");
  const pop = $("load-pop");
  const set = (open: boolean) => {
    pop.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    set(Boolean(pop.hidden));
  });
  document.addEventListener("click", (e) => {
    if (!pop.hidden && !pop.contains(e.target as Node)) set(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) {
      set(false);
      btn.focus();
    }
  });
}

function wireDrop(): void {
  const drop = $("drop");
  let depth = 0;
  const show = (on: boolean) => {
    if ($("app").hidden) document.body.classList.toggle("dragging", on);
    else drop.hidden = !on;
  };
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    depth++;
    show(true);
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    show(false);
    const file = e.dataTransfer?.files[0];
    if (file) void openFile(file);
  });
}

const SCOPES: ScopeKind[] = ["waveform", "parade", "vector"];
const COMPARES: CompareMode[] = ["off", "wipe", "side"];

function wireKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    if ($("app").hidden) return;
    const t = e.target as HTMLElement;
    const textEntry = (t instanceof HTMLInputElement && t.type !== "range" && !t.readOnly) || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
    if (textEntry || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($<HTMLDialogElement>("help").open) return;
    const onRange = t instanceof HTMLInputElement && t.type === "range";
    const k = e.key;
    if (k === "\\") {
      setHold(true);
    } else if (k === " " && !(t instanceof HTMLButtonElement)) {
      togglePlay();
    } else if ((k === "ArrowLeft" || k === "ArrowRight") && !onRange) {
      stepFrames(k === "ArrowRight" ? 1 : -1, e.shiftKey);
    } else if (k === "c" || k === "C") {
      setCompare(COMPARES[(COMPARES.indexOf(state.compare) + 1) % COMPARES.length]);
    } else if (k === "[" || k === "]") {
      stepLook(k === "]" ? 1 : -1);
    } else if (k === "s" || k === "S") {
      setScope(SCOPES[(SCOPES.indexOf(state.scope) + 1) % SCOPES.length]);
    } else if (k === "E") {
      exportStill();
    } else if (k === "e") {
      exportCube();
    } else if (k === "l" || k === "L") {
      toggleLoop();
    } else if (k === "o" || k === "O") {
      $("media-input").click();
    } else if (k === "i" || k === "I") {
      $("cube-input").click();
    } else if (k === "R" && e.shiftKey) {
      resetAll();
    } else if (k === "?") {
      $<HTMLDialogElement>("help").showModal();
    } else return;
    e.preventDefault();
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "\\") setHold(false);
  });
  window.addEventListener("blur", () => setHold(false));
}

// ---------- Boot ----------

function boot(): void {
  const adapterSelect = $<HTMLSelectElement>("adapter-select");
  for (const a of ADAPTERS) adapterSelect.append(new Option(a.name, a.id));
  adapterSelect.addEventListener("change", () => {
    setAdapter(getAdapter(adapterSelect.value));
    state.presetId = "";
    state.basedOn = "";
    syncLooks();
    writeHash();
    toast(`Switched to ${state.adapter.name}. Controls reset to neutral.`);
  });

  buildLooks();
  if (!readHash()) setAdapter(state.adapter);
  wireIntensity();

  wireSeg("compare-seg", "mode", (m) => setCompare(m as CompareMode));
  wireSeg("scope-seg", "scope", (s) => setScope(s as ScopeKind));
  wireSeg("size-seg", "size", (s) => setExportSize(Number(s)));
  setCompare(state.compare);
  setScope(state.scope);
  setExportSize(state.exportSize);

  $("intro-choose").addEventListener("click", () => $("media-input").click());
  $("intro-chart").addEventListener("click", () => void loadImage(CHART_URL, "Test chart").catch((e) => fail((e as Error).message)));
  $("export-btn").addEventListener("click", exportCube);
  $("still-btn").addEventListener("click", exportStill);
  $("import-btn").addEventListener("click", () => $("cube-input").click());
  $("open-btn").addEventListener("click", () => $("media-input").click());
  $("share-btn").addEventListener("click", () => void copyLink());
  $("reset-btn").addEventListener("click", resetAll);
  $("help-btn").addEventListener("click", () => $<HTMLDialogElement>("help").showModal());
  $("imported-close").addEventListener("click", () => closeImported());
  for (const id of ["media-input", "cube-input"]) {
    $<HTMLInputElement>(id).addEventListener("change", (e) => {
      const input = e.target as HTMLInputElement;
      if (input.files?.[0]) void openFile(input.files[0]);
      input.value = "";
    });
  }
  window.addEventListener("hashchange", () => {
    if (readHash()) setIntensity(state.intensity, null);
  });

  wireWipe();
  wireTransport();
  wirePopover();
  wireDrop();
  wireKeyboard();
  new ResizeObserver(() => {
    layoutCanvas();
    renderScopes();
  }).observe($("stage"));
  new ResizeObserver(() => renderScopes()).observe($("scope"));
  rebuild();
  updateLookBlock();

  if (import.meta.env.DEV) Object.assign(window, { __gb: { state, renderer, exportLut } });
}

boot();
