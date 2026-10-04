// The working document: a list of pages drawn from one or more source files.
import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

const PDFJS_BASE = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "pdf.worker.min.mjs";
export { pdfjsLib };

export const A4 = [595.28, 841.89];
export const A3 = [841.89, 1190.55];
const DISPLAY_IMAGE_MAX = 2560;
const SOURCE_COLORS = ["#1f4e79", "#2e7d5b", "#a0522d", "#7b3f8c", "#b23a48", "#2a7f97", "#6b7a2e", "#8a6d00"];

let srcSeq = 0;
let pageSeq = 0;

export class FileOpenError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

/* ---------- File type detection ---------- */

async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const str = String.fromCharCode(...head.slice(0, 1024));
  if (str.includes("%PDF-")) return "pdf";
  if (head[0] === 0xff && head[1] === 0xd8) return "jpeg";
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
  if (str.startsWith("GIF8")) return "gif";
  if (str.startsWith("RIFF") && str.slice(8, 12) === "WEBP") return "webp";
  if (str.startsWith("BM")) return "bmp";
  if (str.slice(4, 8) === "ftyp") {
    const brand = str.slice(8, 12);
    if (/^(avif|avis)/.test(brand)) return "avif";
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand)) return "heic";
  }
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  return null;
}

/* ---------- EXIF orientation (so photos are embedded the right way up) ---------- */

function jpegOrientation(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 2;
    while (off + 4 < dv.byteLength) {
      if (dv.getUint8(off) !== 0xff) return 1;
      const marker = dv.getUint8(off + 1);
      const len = dv.getUint16(off + 2);
      if (marker === 0xe1 && dv.getUint32(off + 4) === 0x45786966) {
        const tiff = off + 10;
        const little = dv.getUint16(tiff) === 0x4949;
        const ifd = tiff + dv.getUint32(tiff + 4, little);
        const n = dv.getUint16(ifd, little);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (dv.getUint16(e, little) === 0x0112) return dv.getUint16(e + 8, little);
        }
        return 1;
      }
      if (marker === 0xda) return 1;
      off += 2 + len;
    }
  } catch (e) { /* not readable: assume upright */ }
  return 1;
}

/* ---------- Loading sources ---------- */

export async function loadSource(file, { askPassword } = {}) {
  const kind = await sniff(file);
  const name = file.name || (kind === "pdf" ? "Shared file.pdf" : "Photo");
  if (!kind) throw new FileOpenError(`“${name}” isn't a PDF or a photo.`, "type");
  if (kind === "pdf") return loadPdfSource(file, name, askPassword);
  if (kind === "heic") throw new FileOpenError(`“${name}” is a HEIC photo, which Chrome can't open. In your camera settings, choose JPEG, or share the photo as JPEG.`, "heic");
  return loadImageSource(file, name, kind);
}

async function loadPdfSource(file, name, askPassword) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: PDFJS_BASE + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: PDFJS_BASE + "standard_fonts/",
    wasmUrl: PDFJS_BASE + "wasm/",
    iccUrl: PDFJS_BASE + "iccs/",
    enableXfa: false
  });
  let cancelled = false;
  let password = null;
  task.onPassword = async (update, reason) => {
    const retry = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    const pw = askPassword ? await askPassword(name, retry) : null;
    if (pw == null) { cancelled = true; task.destroy(); return; }
    password = pw;
    update(pw);
  };
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    if (cancelled) return null;
    throw new FileOpenError(`“${name}” couldn't be opened. The file may be damaged or not a real PDF.`, "pdf");
  }
  const n = pdf.numPages;
  const pages = new Array(n);
  const proxies = await Promise.all(Array.from({ length: n }, (_, i) => pdf.getPage(i + 1)));
  proxies.forEach((p, i) => {
    pages[i] = { view: p.view.slice(), rotate: p.rotate || 0, userUnit: p.userUnit || 1 };
  });
  let encrypted = !!password;
  try {
    const meta = await pdf.getMetadata();
    if (meta && meta.info && meta.info.EncryptFilterName) encrypted = true;
  } catch (e) { /* ignore */ }
  let oc = null;
  try {
    const cfg = await pdf.getOptionalContentConfig();
    if (cfg && cfg.getOrder()) oc = cfg;
  } catch (e) { /* no layers */ }
  return {
    id: ++srcSeq,
    kind: "pdf",
    name,
    bytes,
    pdf,
    pages,
    oc,
    encrypted,
    color: SOURCE_COLORS[(srcSeq - 1) % SOURCE_COLORS.length],
    layerTree: null,
    lib: null
  };
}

async function loadImageSource(file, name, kind) {
  let full;
  try {
    full = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    throw new FileOpenError(`“${name}” couldn't be read as a photo.`, "image");
  }
  const w = full.width;
  const h = full.height;
  let bitmap = full;
  const long = Math.max(w, h);
  if (long > DISPLAY_IMAGE_MAX) {
    const k = DISPLAY_IMAGE_MAX / long;
    const c = new OffscreenCanvas(Math.round(w * k), Math.round(h * k));
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(full, 0, 0, c.width, c.height);
    bitmap = c.transferToImageBitmap();
    full.close();
  }
  let orientation = 1;
  if (kind === "jpeg") orientation = jpegOrientation(new Uint8Array(await file.slice(0, 131072).arrayBuffer()));
  return {
    id: ++srcSeq,
    kind: "image",
    imageType: kind,
    name,
    blob: file,
    w,
    h,
    bitmap,
    orientation,
    color: SOURCE_COLORS[(srcSeq - 1) % SOURCE_COLORS.length]
  };
}

/* ---------- The working document ---------- */

export class Doc {
  constructor() {
    this.name = "";
    this.sources = new Map();
    this.pages = [];
    this.history = [];
    this.dirty = false;
    this.imageFit = "a4";
    this.layerEdits = 0;
    this.listeners = new Map();
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  emit(type, detail) {
    (this.listeners.get(type) || []).forEach((fn) => fn(detail));
  }

  addSource(src, atIndex = this.pages.length) {
    this.sources.set(src.id, src);
    const count = src.kind === "pdf" ? src.pages.length : 1;
    const added = [];
    for (let i = 0; i < count; i++) added.push({ key: ++pageSeq, src: src.id, index: i, rot: 0, crop: null });
    this.pages.splice(atIndex, 0, ...added);
    return added;
  }

  src(page) { return this.sources.get(page.src); }

  get readOnly() {
    for (const s of this.sources.values()) if (s.kind === "pdf" && s.encrypted) return true;
    return false;
  }
  get hasImages() {
    return this.pages.some((p) => this.src(p).kind === "image");
  }
  get layerSources() {
    return [...this.sources.values()].filter((s) => s.kind === "pdf" && s.oc && this.pages.some((p) => p.src === s.id));
  }

  /* history */
  snapshot() {
    return { pages: this.pages.map((p) => ({ ...p, crop: p.crop ? { ...p.crop } : null })), imageFit: this.imageFit };
  }
  commit() {
    this.history.push(this.snapshot());
    if (this.history.length > 60) this.history.shift();
    this.dirty = true;
  }
  undo() {
    const s = this.history.pop();
    if (!s) return false;
    this.pages = s.pages;
    this.imageFit = s.imageFit;
    this.dirty = true;
    this.emit("pages", { undo: true });
    return true;
  }
  changed(detail) {
    this.emit("pages", detail || {});
  }

  /* geometry */
  base(p) {
    const s = this.src(p);
    if (s.kind === "pdf") {
      const info = s.pages[p.index];
      const v = info.view;
      return { W: (v[2] - v[0]) * info.userUnit, H: (v[3] - v[1]) * info.userUnit, R: ((info.rotate + p.rot) % 360 + 360) % 360 };
    }
    return { W: s.w, H: s.h, R: ((p.rot % 360) + 360) % 360 };
  }

  // Size of the cropped, rotated content (points for PDFs, pixels for photos).
  contentSize(p) {
    const { W, H, R } = this.base(p);
    const c = p.crop || FULL;
    let w = (c.x1 - c.x0) * W;
    let h = (c.y1 - c.y0) * H;
    if (R % 180 === 90) [w, h] = [h, w];
    return { w, h };
  }

  // Final page size in points, as it will be saved.
  pageSize(p) {
    const s = this.src(p);
    const c = this.contentSize(p);
    if (s.kind === "pdf") return { w: c.w, h: c.h };
    return imagePageSize(c.w, c.h, this.imageFit);
  }
}

export const FULL = Object.freeze({ x0: 0, y0: 0, x1: 1, y1: 1 });

export function imagePageSize(cw, ch, fit) {
  const landscape = cw > ch;
  if (fit === "a4" || fit === "a3") {
    const [a, b] = fit === "a4" ? A4 : A3;
    return landscape ? { w: b, h: a } : { w: a, h: b };
  }
  const short = A4[0];
  const k = short / Math.min(cw, ch);
  return { w: cw * k, h: ch * k };
}

// Where a photo sits on its page (points, top-left origin): fitted and centred.
export function imagePlacement(page, cw, ch) {
  const k = Math.min(page.w / cw, page.h / ch);
  const w = cw * k;
  const h = ch * k;
  return { x: (page.w - w) / 2, y: (page.h - h) / 2, w, h };
}

// Map a point on the displayed (rotated) content, 0..1, to unrotated 0..1 coordinates.
export function displayToBase(u, v, R) {
  switch (R) {
    case 90: return [v, 1 - u];
    case 180: return [1 - u, 1 - v];
    case 270: return [1 - v, u];
    default: return [u, v];
  }
}
export function baseToDisplay(x, y, R) {
  switch (R) {
    case 90: return [1 - y, x];
    case 180: return [1 - x, 1 - y];
    case 270: return [y, 1 - x];
    default: return [x, y];
  }
}

export function closeSource(s) {
  try {
    if (s.pdf) s.pdf.loadingTask.destroy();
    if (s.bitmap) s.bitmap.close();
  } catch (e) { /* already closed */ }
}

// pdf-lib's view of a PDF source (used for saving and for reading the layer tree).
export async function libDoc(src) {
  if (src.lib) return src.lib;
  if (!window.PDFLib) throw new Error("PDF library not loaded");
  src.lib = await window.PDFLib.PDFDocument.load(src.bytes, { updateMetadata: false, throwOnInvalidObject: false });
  return src.lib;
}

export function baseName(name) {
  return String(name || "").replace(/\.[a-z0-9]{2,5}$/i, "").trim() || "Document";
}
