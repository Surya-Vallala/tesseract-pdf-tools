// Reading text from scanned pages (Tesseract, running on the phone).
import { rot, apply } from "./geom.js";
import { pdfjsLib } from "./doc.js";

const VENDOR = new URL("../vendor/", import.meta.url).href;
const RUNTIME_CACHE = "tpt-runtime";

export const LANGS = [
  { code: "eng", name: "English", mb: 2.9 },
  { code: "tel", name: "Telugu", mb: 1.7 },
  { code: "hin", name: "Hindi", mb: 1.4 }
];

const langUrl = (code) => `${VENDOR}tessdata/${code}.traineddata.gz`;

export async function langReady(code) {
  try { return !!(await caches.match(langUrl(code))); } catch (e) { return false; }
}

export async function downloadLang(code) {
  const url = langUrl(code);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("download");
  const cache = await caches.open(RUNTIME_CACHE);
  await cache.put(url, res.clone());
  await res.arrayBuffer();
}

let worker = null;
let workerKey = "";

async function getWorker(langs) {
  const key = langs.join("+");
  if (worker && workerKey === key) return worker;
  if (worker) { try { await worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
  const T = await import("../vendor/tesseract/tesseract.esm.min.js");
  const createWorker = T.createWorker || (T.default && T.default.createWorker);
  worker = await createWorker(langs, 1, {
    workerPath: VENDOR + "tesseract/worker.min.js",
    corePath: VENDOR + "tesseract/",
    langPath: VENDOR + "tessdata",
    cacheMethod: "none",
    gzip: true,
    workerBlobURL: false
  });
  workerKey = key;
  return worker;
}

export async function stopOcr() {
  if (worker) { try { await worker.terminate(); } catch (e) { /* ignore */ } }
  worker = null;
  workerKey = "";
}

function collectWords(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => collectWords(n, out)); return; }
  if (Array.isArray(node.words)) {
    for (const w of node.words) {
      if (w && w.bbox && w.text && w.text.trim()) out.push(w);
    }
    return;
  }
  for (const k of ["blocks", "paragraphs", "lines"]) if (node[k]) collectWords(node[k], out);
}

// Draw a page upright (as you see it) for reading. Returns { canvas, k } where k is
// pixels per base unit.
async function renderForOcr(doc, p) {
  const s = doc.src(p);
  const { W, H, R } = doc.base(p);
  const turned = R % 180 === 90;
  const longBase = Math.max(W, H);
  if (s.kind === "pdf") {
    const page = await s.pdf.getPage(p.index + 1);
    const info = s.pages[p.index];
    const k = Math.min(300 / 72, 3600 / longBase);
    const vp = page.getViewport({ scale: k / (info.userUnit || 1), rotation: R });
    const c = document.createElement("canvas");
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const ctx = c.getContext("2d", { alpha: false });
    await page.render({ canvasContext: ctx, canvas: c, viewport: vp, background: "#ffffff", annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
    return { canvas: c, k };
  }
  if (s.kind === "image") {
    const bw = s.bitmap.width, bh = s.bitmap.height;
    const k = bw / s.w;
    const c = document.createElement("canvas");
    c.width = turned ? bh : bw;
    c.height = turned ? bw : bh;
    const ctx = c.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    const m = rot(R, bw, bh);
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(s.bitmap, 0, 0);
    return { canvas: c, k };
  }
  return null;
}

/**
 * Read the given pages. Results go on each source: s.ocr[index] = { R, words, text }, with word
 * boxes in "upright page" units (the page turned to R, in base units).
 */
export async function recognize(doc, pages, langs, onProgress) {
  onProgress && onProgress("Starting the text reader…");
  const w = await getWorker(langs);
  let done = 0, found = 0;
  for (const p of pages) {
    const s = doc.src(p);
    if (s.kind === "blank") { done++; continue; }
    onProgress && onProgress(`Reading page ${done + 1} of ${pages.length}…`);
    const r = await renderForOcr(doc, p);
    if (!r) { done++; continue; }
    const { data } = await w.recognize(r.canvas, {}, { text: true, blocks: true });
    r.canvas.width = 0;
    const raw = [];
    collectWords(data.blocks || [], raw);
    const { R } = doc.base(p);
    const words = raw.map((x) => ({ t: x.text.trim(), x0: x.bbox.x0 / r.k, y0: x.bbox.y0 / r.k, x1: x.bbox.x1 / r.k, y1: x.bbox.y1 / r.k }));
    if (!s.ocr) s.ocr = {};
    s.ocr[p.index] = { R, words, text: (data.text || "").trim() };
    if (words.length) found++;
    done++;
  }
  return { pages: done, withText: found };
}

/** All the text in the document, page by page. */
export async function documentText(doc) {
  const parts = [];
  for (let i = 0; i < doc.pages.length; i++) {
    const p = doc.pages[i];
    const s = doc.src(p);
    let text = "";
    const ocr = s.ocr && s.ocr[p.index];
    if (ocr && ocr.text) text = ocr.text;
    else if (s.kind === "pdf") {
      try {
        const page = await s.pdf.getPage(p.index + 1);
        const tc = await page.getTextContent();
        text = tc.items.map((it) => (it.str || "") + (it.hasEOL ? "\n" : "")).join("").replace(/[ \t]+\n/g, "\n").trim();
      } catch (e) { text = ""; }
    }
    parts.push(`Page ${i + 1}\n\n${text || "(no text found)"}`);
  }
  return parts.join("\n\n\n");
}

export function pageHasText(doc, p) {
  const s = doc.src(p);
  return !!(s.ocr && s.ocr[p.index] && s.ocr[p.index].words.length);
}

export { apply };
