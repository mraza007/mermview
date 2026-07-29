import mermaid from "mermaid";
import "./style.css";

type MermaidTheme = "default" | "dark" | "forest" | "neutral" | "base";
type AppTheme = "light" | "dark";

interface AppState {
  source: string;
  appTheme: AppTheme;
  mermaidTheme: MermaidTheme;
  editorCollapsed: boolean;
  editorWidth: number; // percentage of window width
}

const STORAGE_KEY = "mermaid-viewer-state";

const DEFAULT_SOURCE = `graph TD
  A[Paste a mermaid diagram] --> B{Renders live}
  B -->|Pan & zoom| C[Scroll and drag the preview]
  B -->|Export| D[SVG / PNG / Copy PNG]`;

const DEFAULT_STATE: AppState = {
  source: DEFAULT_SOURCE,
  appTheme: window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light",
  mermaidTheme: "default",
  editorCollapsed: false,
  editorWidth: 34,
};

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    // corrupted state — fall back to defaults
  }
  return { ...DEFAULT_STATE };
}

const state = loadState();

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const editor = $<HTMLTextAreaElement>("editor");
const editorPane = $<HTMLDivElement>("editor-pane");
const divider = $<HTMLDivElement>("divider");
const viewport = $<HTMLDivElement>("viewport");
const stage = $<HTMLDivElement>("stage");
const errorBar = $<HTMLDivElement>("error-bar");
const toast = $<HTMLDivElement>("toast");
const toggleEditorBtn = $<HTMLButtonElement>("toggle-editor");
const fitBtn = $<HTMLButtonElement>("fit");
const exportSvgBtn = $<HTMLButtonElement>("export-svg");
const exportPngBtn = $<HTMLButtonElement>("export-png");
const copyPngBtn = $<HTMLButtonElement>("copy-png");
const mermaidThemeSelect = $<HTMLSelectElement>("mermaid-theme");
const appThemeBtn = $<HTMLButtonElement>("toggle-app-theme");

// ---------- mermaid rendering ----------

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: state.mermaidTheme,
    // SVG text labels (not <foreignObject>) so PNG export via canvas works
    flowchart: { htmlLabels: false },
  });
}

let renderSeq = 0;
let hasFitted = false;

async function render() {
  const source = editor.value.trim();
  if (!source) {
    stage.innerHTML = "";
    hideError();
    return;
  }
  const id = `mmd-${++renderSeq}`;
  try {
    const { svg } = await mermaid.render(id, source);
    stage.innerHTML = svg;
    normalizeSvg();
    hideError();
    if (!hasFitted) {
      fitToView();
      hasFitted = true;
    }
  } catch (err) {
    // mermaid can leave a stray error element behind on failure
    document.getElementById(`d${id}`)?.remove();
    showError(err instanceof Error ? err.message : String(err));
  }
}

// Give the SVG its intrinsic pixel size so pan/zoom math and export are exact.
function normalizeSvg() {
  const svg = stage.querySelector("svg");
  if (!svg) return;
  const vb = svg.viewBox.baseVal;
  if (vb && vb.width > 0) {
    svg.setAttribute("width", String(vb.width));
    svg.setAttribute("height", String(vb.height));
  }
  svg.style.maxWidth = "none";
}

function currentSvg(): SVGSVGElement | null {
  return stage.querySelector("svg");
}

const RENDER_DEBOUNCE_MS = 300;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, RENDER_DEBOUNCE_MS);
}

// ---------- error bar / toast ----------

function showError(message: string) {
  errorBar.textContent = message;
  errorBar.hidden = false;
}

function hideError() {
  errorBar.hidden = true;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(message: string) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 2000);
}

// ---------- pan / zoom ----------

const view = { x: 0, y: 0, scale: 1 };
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

function applyTransform() {
  stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

function fitToView() {
  const svg = currentSvg();
  if (!svg) return;
  const w = Number(svg.getAttribute("width"));
  const h = Number(svg.getAttribute("height"));
  if (!w || !h) return;
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  view.scale = Math.min(vw / w, vh / h, MAX_SCALE) * 0.95;
  view.scale = Math.max(view.scale, MIN_SCALE);
  view.x = (vw - w * view.scale) / 2;
  view.y = (vh - h * view.scale) / 2;
  applyTransform();
}

viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.002);
    const newScale = Math.min(
      Math.max(view.scale * factor, MIN_SCALE),
      MAX_SCALE,
    );
    // zoom around the cursor
    view.x = px - ((px - view.x) / view.scale) * newScale;
    view.y = py - ((py - view.y) / view.scale) * newScale;
    view.scale = newScale;
    applyTransform();
  },
  { passive: false },
);

let panPointer: number | null = null;
let panStart = { x: 0, y: 0, vx: 0, vy: 0 };

viewport.addEventListener("pointerdown", (e) => {
  panPointer = e.pointerId;
  panStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  viewport.setPointerCapture(e.pointerId);
  viewport.classList.add("panning");
});

viewport.addEventListener("pointermove", (e) => {
  if (e.pointerId !== panPointer) return;
  view.x = panStart.vx + (e.clientX - panStart.x);
  view.y = panStart.vy + (e.clientY - panStart.y);
  applyTransform();
});

viewport.addEventListener("pointerup", (e) => {
  if (e.pointerId !== panPointer) return;
  panPointer = null;
  viewport.classList.remove("panning");
});

fitBtn.addEventListener("click", fitToView);

// ---------- export ----------

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function svgBlob(): Blob | null {
  const svg = currentSvg();
  if (!svg) return null;
  const str = new XMLSerializer().serializeToString(svg);
  return new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + str], {
    type: "image/svg+xml;charset=utf-8",
  });
}

async function svgToPngBlob(scale = 2): Promise<Blob | null> {
  const svg = currentSvg();
  if (!svg) return null;
  const w = Number(svg.getAttribute("width"));
  const h = Number(svg.getAttribute("height"));
  if (!w || !h) return null;

  const str = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(
    new Blob([str], { type: "image/svg+xml;charset=utf-8" }),
  );
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not rasterize SVG"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = state.mermaidTheme === "dark" ? "#16181d" : "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

exportSvgBtn.addEventListener("click", () => {
  const blob = svgBlob();
  if (!blob) return showToast("Nothing to export");
  download(blob, "diagram.svg");
});

exportPngBtn.addEventListener("click", async () => {
  try {
    const blob = await svgToPngBlob();
    if (!blob) return showToast("Nothing to export");
    download(blob, "diagram.png");
  } catch (err) {
    showToast(err instanceof Error ? err.message : "PNG export failed");
  }
});

copyPngBtn.addEventListener("click", async () => {
  try {
    const blob = await svgToPngBlob();
    if (!blob) return showToast("Nothing to copy");
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob }),
    ]);
    showToast("PNG copied to clipboard");
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Copy failed");
  }
});

// ---------- editor / paste ----------

editor.addEventListener("input", () => {
  state.source = editor.value;
  saveState();
  scheduleRender();
});

// Paste anywhere on the page (outside the editor) replaces the diagram.
window.addEventListener("paste", (e) => {
  if (e.target === editor) return;
  const text = e.clipboardData?.getData("text/plain");
  if (!text?.trim()) return;
  e.preventDefault();
  editor.value = text;
  state.source = text;
  saveState();
  hasFitted = false;
  scheduleRender();
});

// ---------- layout: split drag + collapse ----------

function applyEditorWidth() {
  editorPane.style.setProperty("--editor-width", `${state.editorWidth}%`);
  editorPane.style.flexBasis = `${state.editorWidth}%`;
}

divider.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  divider.setPointerCapture(e.pointerId);
  const onMove = (ev: PointerEvent) => {
    const pct = (ev.clientX / window.innerWidth) * 100;
    state.editorWidth = Math.min(Math.max(pct, 10), 80);
    applyEditorWidth();
  };
  const onUp = () => {
    divider.removeEventListener("pointermove", onMove);
    divider.removeEventListener("pointerup", onUp);
    saveState();
  };
  divider.addEventListener("pointermove", onMove);
  divider.addEventListener("pointerup", onUp);
});

function applyEditorCollapsed() {
  document.body.classList.toggle("editor-collapsed", state.editorCollapsed);
  toggleEditorBtn.textContent = state.editorCollapsed
    ? "Show code"
    : "Hide code";
}

toggleEditorBtn.addEventListener("click", () => {
  state.editorCollapsed = !state.editorCollapsed;
  applyEditorCollapsed();
  saveState();
});

// ---------- themes ----------

function applyAppTheme() {
  document.documentElement.dataset.theme = state.appTheme;
  appThemeBtn.textContent = state.appTheme === "dark" ? "☀️" : "🌙";
}

appThemeBtn.addEventListener("click", () => {
  state.appTheme = state.appTheme === "dark" ? "light" : "dark";
  applyAppTheme();
  saveState();
});

mermaidThemeSelect.addEventListener("change", () => {
  state.mermaidTheme = mermaidThemeSelect.value as MermaidTheme;
  saveState();
  initMermaid();
  render();
});

// ---------- boot ----------

editor.value = state.source;
mermaidThemeSelect.value = state.mermaidTheme;
applyAppTheme();
applyEditorCollapsed();
applyEditorWidth();
initMermaid();
render();
