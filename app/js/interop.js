// Drawings shared with the Windows app. Both apps keep each drawing as a PDF annotation with
// an appearance (so every PDF viewer shows it) and their own description of it as JSON under
// /TPTDraw, on drawing layers marked /TPTSketch. The phone reads those into its marks when a PDF
// opens, and writes its marks back the same way when it saves, so either app can edit them.
//
// Positions: the Windows app keeps strokes and lines in PDF user space, and boxes (shapes,
// blocks) as a local box with a matrix to PDF user space. The phone works in base units; ctx.b2p
// is base -> PDF user space for the page, ctx.pt is the base length of one point.
import { libDoc, newId } from "./doc.js";
import { mul, inv, apply } from "./geom.js";
import { PEN_KIND, shapeFrame, curveControl, fillOf, fillOpacityOf, smoothCmds } from "./shapes.js";
import { LINE_KINDS, BOX_KINDS } from "./dgeom.js";

export const DRAW_KEY = "TPTDraw";
export const SKETCH_KEY = "TPTSketch";
export const SCALE_KEY = "TPTScale";
export const FILE_KEY = "TPTFile";
export const GROUP_LABEL = "Drawing layers";

const TO_DESK = { circle: "ellipse", curved: "curved_arrow", polygon: "ngon", poly: "polygon" };
const FROM_DESK = { ellipse: "circle", curved_arrow: "curved", ngon: "polygon", polygon: "poly" };
const PENS = new Set(["pen", "marker", "highlighter"]);

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r3 = (v) => Math.round(v * 1e3) / 1e3;
const deg = (rad) => (((rad * 180) / Math.PI) % 360 + 360) % 360;

/** base -> PDF user space for a page of a PDF source (pdf.js "view" and UserUnit). */
export function pdfPageMatrix(info) {
  const uu = info.userUnit || 1;
  return [1 / uu, 0, 0, -1 / uu, info.view[0], info.view[3]];
}

/** JSON with only ASCII characters (the Windows app reads it that way). */
export function asciiJSON(o) {
  return JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/* ---------- Windows app -> phone ---------- */

/**
 * The phone's marks for one of the Windows app's drawings: a list (a stroke with several pieces
 * becomes several marks), or null when the phone can't edit it (tables): it then stays in the
 * PDF as it is, shown and kept but not editable here.
 */
export function fromDesk(d, ctx) {
  const P2B = inv(ctx.b2p);
  const pt = ctx.pt;
  const meta = { author: d.author || "", created: d.created || "" };
  const base = { color: d.color || "#1F2328", opacity: d.opacity == null ? 1 : d.opacity, layer: d.layer || "", meta };
  if (d.kind === "ink") {
    if (!PENS.has(d.tool) || !Array.isArray(d.paths)) return null;
    const out = [];
    d.paths.forEach((path, i) => {
      if (!Array.isArray(path) || !path.length) return;
      const pts = [];
      for (const q of path) { const b = apply(P2B, q[0], q[1]); pts.push(b[0], b[1]); }
      if (pts.length === 2) pts.push(pts[0] + 0.01, pts[1]);
      out.push({ ...base, id: i ? `${d.id}-${i}` : d.id, kind: "ink", pen: d.tool, w: (d.width || 1) * pt, pts, poly: true });
    });
    return out.length ? out : null;
  }
  if (d.kind === "shape" && LINE_KINDS.has(FROM_DESK[d.tool] || d.tool)) {
    const shape = FROM_DESK[d.tool] || d.tool;
    const P = (d.paths || []).map((q) => apply(P2B, q[0], q[1]));
    if (P.length < 2) return null;
    const it = { ...base, id: d.id, kind: "shape", shape, x1: P[0][0], y1: P[0][1], x2: P[P.length - 1][0], y2: P[P.length - 1][1],
      w: (d.width || 1) * pt, hs: (d.hs || 0) * pt, dashed: !!d.dashed, fill: "", text: "" };
    if (shape === "curved" && P.length >= 3) { it.qx = P[1][0]; it.qy = P[1][1]; }
    return [it];
  }
  if (d.kind === "shape" || d.kind === "block") {
    const L = mul(P2B, d.m || [1, 0, 0, 1, 0, 0]);
    const sx = Math.hypot(L[0], L[1]), sy = Math.hypot(L[2], L[3]);
    const det = L[0] * L[3] - L[1] * L[2];
    if (!(sx > 0) || !(sy > 0) || det <= 0) return null; // mirrored: leave it as it is
    if (Math.abs(L[0] * L[2] + L[1] * L[3]) > 1e-6 * sx * sy) return null; // slanted
    const rot = r6(deg(Math.atan2(L[1], L[0])));
    const cx = L[4], cy = L[5];
    if (d.kind === "block") {
      if (Math.abs(sx - sy) > 1e-4 * sx) return null;
      const b = d.block || {};
      return [{ ...base, id: d.id, kind: "shape", shape: "block", family: b.family || "", name: b.name || "Block", p: b.p || null,
        bw: d.w, bd: d.h, x1: cx, y1: cy, x2: cx, y2: cy, rot, flip: !!b.flip, k: sx, w: (d.width || 1) * pt,
        fill: d.fill || "", fa: d.fa == null ? 1 : d.fa, text: "" }];
    }
    const tool = d.tool;
    if (!BOX_KINDS.has(FROM_DESK[tool] || tool)) return null;
    const shape = FROM_DESK[tool] || tool;
    const w = (d.w || 0) * sx, h = (d.h || 0) * sy;
    const style = { w: (d.width || 1) * sx, fill: d.fill || "", fa: d.fa == null ? 1 : d.fa, dashed: !!d.dashed,
      text: d.label || "", ls: (d.ls || 0) * sx };
    if (shape === "poly") {
      const pts = [];
      for (const [u, v] of d.paths || []) { const q = apply(L, u * d.w, v * d.h); pts.push(q[0], q[1]); }
      if (pts.length < 6) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
      return [{ ...base, ...style, id: d.id, kind: "shape", shape, pts, x1: x0, y1: y0, x2: x1, y2: y1, rot: 0 }];
    }
    const it = { ...base, ...style, id: d.id, kind: "shape", shape, x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, rot };
    if (shape === "polygon") it.sides = d.n || 6;
    return [it];
  }
  return null;
}

/* ---------- phone -> Windows app ---------- */

// A pen stroke as the phone draws it (a smooth curve through its points), as a polyline.
function strokePoints(it) {
  if (it.poly || it.pts.length === 4) {
    const out = [];
    for (let i = 0; i < it.pts.length; i += 2) out.push([it.pts[i], it.pts[i + 1]]);
    return out;
  }
  const cmds = smoothCmds(it.pts);
  const out = [];
  let cur = null;
  for (const c of cmds) {
    if (c[0] === "M" || c[0] === "L") { cur = [c[1], c[2]]; out.push(cur); }
    else if (c[0] === "C" && cur) {
      const [x0, y0] = cur;
      for (let i = 1; i <= 4; i++) {
        const t = i / 4, u = 1 - t;
        out.push([u * u * u * x0 + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
          u * u * u * y0 + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6]]);
      }
      cur = [c[5], c[6]];
    }
  }
  return out;
}

/** The Windows app's description of one of the phone's marks (ink or shape), or null. */
export function toDesk(it, ctx) {
  const pt = ctx.pt;
  const B = ctx.b2p;
  const P = (x, y) => { const q = apply(B, x, y); return [r3(q[0]), r3(q[1])]; };
  const meta = it.meta || {};
  const d = {
    id: it.id, kind: "shape", tool: "", layer: it.layer || "", color: it.color || "#1F2328", width: 1,
    opacity: it.opacity == null ? 1 : it.opacity, fill: "", dashed: !!it.dashed, paths: [], w: 0, h: 0,
    m: [1, 0, 0, 1, 0, 0], label: "", ls: 0, hs: 0, table: null, n: 0, fa: 1, block: null,
    author: meta.author || ctx.author || "", created: meta.created || ctx.now || ""
  };
  if (it.kind === "ink") {
    const k = PEN_KIND[it.pen] || PEN_KIND.pen;
    d.kind = "ink";
    d.tool = PENS.has(it.pen) ? it.pen : "pen";
    d.width = r3(it.w / pt);
    d.opacity = it.opacity == null ? k.opacity : it.opacity;
    d.paths = [strokePoints(it).map(([x, y]) => P(x, y))];
    return d;
  }
  if (it.kind !== "shape") return null;
  if (it.shape === "block") {
    const a = ((it.rot || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    d.kind = "block";
    d.tool = "block";
    d.w = it.bw; d.h = it.bd;
    d.m = mul(B, mul([c, s, -s, c, it.x1, it.y1], [it.k, 0, 0, it.k, 0, 0])).map(r6);
    d.block = { family: it.family, name: it.name, p: it.p || null, flip: !!it.flip };
    d.width = r3(it.w / pt);
    d.fill = it.fill === true ? "#FFFFFF" : it.fill || "";
    d.fa = it.fa == null ? 1 : it.fa;
    d.dashed = false;
    return d;
  }
  d.tool = TO_DESK[it.shape] || it.shape;
  d.width = r3(it.w / pt);
  if (LINE_KINDS.has(it.shape)) {
    d.paths = it.shape === "curved" ? [P(it.x1, it.y1), P(...curveControl(it)), P(it.x2, it.y2)] : [P(it.x1, it.y1), P(it.x2, it.y2)];
    d.hs = r3((it.hs || 0) / pt);
    return d;
  }
  d.fill = fillOf(it);
  d.fa = fillOpacityOf(it);
  d.label = it.shape === "section" && it.text2 ? `${it.text || ""}\n${it.text2}` : it.text || "";
  d.ls = r3((it.ls || 0) / pt);
  if (it.shape === "poly") {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < it.pts.length; i += 2) { x0 = Math.min(x0, it.pts[i]); x1 = Math.max(x1, it.pts[i]); y0 = Math.min(y0, it.pts[i + 1]); y1 = Math.max(y1, it.pts[i + 1]); }
    const w = Math.max(x1 - x0, 1e-6), h = Math.max(y1 - y0, 1e-6), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    d.w = r3(w / pt); d.h = r3(h / pt);
    d.m = mul(B, [pt, 0, 0, pt, cx, cy]).map(r6);
    d.paths = [];
    for (let i = 0; i < it.pts.length; i += 2) d.paths.push([r6((it.pts[i] - cx) / w), r6((it.pts[i + 1] - cy) / h)]);
    return d;
  }
  const f = shapeFrame(it);
  const c = Math.cos(f.a), s = Math.sin(f.a);
  d.w = r3(f.w / pt); d.h = r3(f.h / pt);
  d.m = mul(B, mul([c, s, -s, c, f.cx, f.cy], [pt, 0, 0, pt, 0, 0])).map(r6);
  if (it.shape === "polygon") d.n = it.sides || 6;
  return d;
}

/* ---------- reading a PDF's drawings, layers and scales ---------- */

const refId = (ref) => (ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`);

function textOf(v) {
  if (!v) return "";
  try { return v.decodeText ? v.decodeText() : String(v); } catch (e) { return ""; }
}

/** A quick look: might this PDF hold drawings or drawing layers from either app? */
export function mightHaveDrawings(bytes) {
  const dec = new TextDecoder("latin1");
  const CH = 4 << 20;
  for (let i = 0; i < bytes.length; i += CH) {
    const t = dec.decode(bytes.subarray(i, Math.min(bytes.length, i + CH + 16)));
    if (t.includes("TPTDraw") || t.includes("TPTSketch") || t.includes("TPTScale") || t.includes("/ObjStm")) return true;
  }
  return false;
}

/**
 * Reads the drawing layers, drawings and drawing scales of a PDF source (pdf-lib). Returns
 * { layers: [{ id, name, ref, on }], pages: [{ items, hidden: [annot ids], foreign: n, scale, file }] } or null.
 */
export async function readDrawings(src) {
  const lib = await libDoc(src);
  const L = window.PDFLib;
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } = L;
  const ctx = lib.context;
  const cat = lib.catalog;
  // drawing layers, in their order in the layer list
  const layers = [];
  const byRef = new Map();
  const ocp = cat.lookupMaybe(PDFName.of("OCProperties"), PDFDict);
  if (ocp) {
    const ocgs = ocp.lookupMaybe(PDFName.of("OCGs"), PDFArray);
    const D = ocp.lookupMaybe(PDFName.of("D"), PDFDict);
    const off = new Set(((D && D.lookupMaybe(PDFName.of("OFF"), PDFArray)) || { asArray: () => [] }).asArray().filter((r) => r instanceof PDFRef).map(refId));
    for (const r of (ocgs ? ocgs.asArray() : [])) {
      if (!(r instanceof PDFRef)) continue;
      const g = ctx.lookupMaybe(r, PDFDict);
      const sk = g && g.get(PDFName.of(SKETCH_KEY));
      if (!sk) continue;
      const l = { id: textOf(sk), name: textOf(g.get(PDFName.of("Name"))) || "Layer", ref: refId(r), on: !off.has(refId(r)) };
      if (l.id) { layers.push(l); byRef.set(l.ref, l); }
    }
    // the order of the layer list
    const order = D && D.lookupMaybe(PDFName.of("Order"), PDFArray);
    if (order && layers.length > 1) {
      const seq = [];
      const walk = (arr, depth) => {
        if (depth > 12) return;
        for (const v of arr) {
          if (v instanceof PDFRef) {
            const o = ctx.lookup(v);
            if (o instanceof PDFArray) walk(o.asArray(), depth + 1);
            else if (byRef.has(refId(v)) && !seq.includes(byRef.get(refId(v)))) seq.push(byRef.get(refId(v)));
          } else if (v instanceof PDFArray) walk(v.asArray(), depth + 1);
        }
      };
      walk(order.asArray(), 0);
      for (const l of layers) if (!seq.includes(l)) seq.push(l);
      layers.splice(0, layers.length, ...seq);
    }
  }
  const pages = [];
  const libPages = lib.getPages();
  libPages.forEach((pg, i) => {
    const info = src.pages[i];
    const out = { items: [], hidden: [], keep: [], foreign: 0, scale: null, file: "" };
    pages.push(out);
    const node = pg.node;
    const sc = node.get(PDFName.of(SCALE_KEY));
    if (sc instanceof PDFNumber && sc.asNumber() > 0) out.scale = sc.asNumber();
    out.file = textOf(node.get(PDFName.of(FILE_KEY)));
    const annots = node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots || !info) return;
    const pctx = { b2p: pdfPageMatrix(info), pt: info.userUnit || 1 };
    for (const r of annots.asArray()) {
      const a = r instanceof PDFRef ? ctx.lookupMaybe(r, PDFDict) : r instanceof PDFDict ? r : null;
      if (!a) continue;
      const raw = a.get(PDFName.of(DRAW_KEY));
      if (!raw) continue;
      let d = null;
      try { d = JSON.parse(textOf(raw)); } catch (e) { d = null; }
      if (!d || !d.id) { out.foreign++; continue; }
      const items = fromDesk(d, pctx);
      if (items && r instanceof PDFRef) {
        out.items.push(...items);
        out.hidden.push({ annot: refId(r), id: d.id });
      } else {
        out.foreign++;
        if (r instanceof PDFRef) out.keep.push(refId(r));
      }
    }
  });
  return { layers, pages };
}

/**
 * Brings a PDF source's drawings into the document: the drawing layers join the document's,
 * the drawings become marks on its pages, and pdf.js stops drawing those annotations itself.
 * pages: the document's pages that come from this source.
 */
export async function importDrawings(doc, src, pages) {
  if (src.kind !== "pdf" || src.locked || !mightHaveDrawings(src.bytes)) return false;
  let data;
  try { data = await readDrawings(src); } catch (e) { console.warn("Reading drawings failed", e); return false; }
  if (!data) return false;
  const any = data.layers.length || data.pages.some((p) => p.items.length || p.scale || p.foreign);
  if (!any) return false;
  // layers: the same id is the same layer (two files saved from one drawing)
  src.sketch = new Map(); // OCG id in pdf.js -> drawing layer id
  for (const l of data.layers) {
    let mine = doc.layer(l.id);
    if (!mine) {
      mine = { id: l.id, name: l.name, visible: l.on };
      doc.layers.push(mine);
    }
    mine.refs = { ...(mine.refs || {}), [src.id]: l.ref };
    src.sketch.set(l.ref, l.id);
  }
  // drawings onto the pages
  src.imported = new Set();
  src.hiddenAnnots = new Map(); // pdf.js annotation id -> page index
  src.foreign = data.pages.some((p) => p.foreign > 0);
  src.keepAnnots = new Set(data.pages.flatMap((p) => p.keep)); // drawings pdf.js still draws
  const firstLayer = () => doc.ensureLayer().id;
  for (const p of pages) {
    const pd = data.pages[p.index];
    if (!pd) continue;
    if (pd.scale) p.blockK = pd.scale * (src.pages[p.index].userUnit || 1);
    for (const it of pd.items) {
      const copy = structuredClone(it);
      if (!copy.layer || !doc.layer(copy.layer)) copy.layer = firstLayer();
      if (copy.kind === "shape" && copy.shape === "block" && !p.blockK) p.blockK = copy.k;
      p.items.push(copy);
    }
    for (const h of pd.hidden) { src.imported.add(h.id); src.hiddenAnnots.set(h.annot, p.index); }
  }
  if (doc.layers.length && !doc.layer(doc.activeLayer)) doc.activeLayer = doc.layers[doc.layers.length - 1].id;
  hideConverted(src);
  syncSketchVisibility(doc);
  return true;
}

/** pdf.js must not draw the drawings the phone now draws itself. */
function hideConverted(src) {
  const st = src.pdf && src.pdf.annotationStorage;
  if (!st || !src.hiddenAnnots) return;
  for (const [annot, pageIndex] of src.hiddenAnnots) {
    st.setValue(`pdfjs_internal_editor_tpt${annot}`, { deleted: true, id: annot, pageIndex });
  }
  src.annVer = (src.annVer || 0) + 1;
}

/**
 * Comments off: pdf.js would hide every annotation, the Windows app's tables too. On files with
 * such drawings, hide just the comments instead (and show them again when comments are on).
 */
export async function applyCommentVisibility(doc) {
  let changed = false;
  for (const s of doc.sources.values()) {
    if (!s.foreign || !s.pdf) continue;
    const st = s.pdf.annotationStorage;
    s.commentKeys = s.commentKeys || new Map();
    if (doc.commentsVisible) {
      for (const key of s.commentKeys.keys()) { if (typeof st.remove === "function") st.remove(key); }
      if (s.commentKeys.size) changed = true;
      s.commentKeys.clear();
      continue;
    }
    for (let i = 0; i < s.pages.length; i++) {
      let annots = [];
      try { annots = await (await s.pdf.getPage(i + 1)).getAnnotations(); } catch (e) { continue; }
      for (const a of annots) {
        if (!a.id || s.keepAnnots.has(a.id) || (s.hiddenAnnots && s.hiddenAnnots.has(a.id))) continue;
        const key = `pdfjs_internal_editor_tptc${a.id}`;
        st.setValue(key, { deleted: true, id: a.id, pageIndex: i });
        s.commentKeys.set(key, i);
        changed = true;
      }
    }
  }
  if (changed) for (const s of doc.sources.values()) if (s.foreign) s.annVer = (s.annVer || 0) + 1;
  return changed;
}

/** The drawings pdf.js still draws (tables and others the phone keeps as they are) follow the layers. */
export function syncSketchVisibility(doc) {
  for (const s of doc.sources.values()) {
    if (!s.sketch || !s.oc) continue;
    for (const [ref, lid] of s.sketch) {
      const l = doc.layer(lid);
      if (!l) continue;
      try { s.oc.setVisibility(ref, !!l.visible); } catch (e) { /* not a group pdf.js knows */ }
    }
  }
}

/** The PDF-layer ids (pdf.js) of a source that are drawing layers, not the PDF's own. */
export function sketchGroupIds(src) {
  return src.sketch ? new Set(src.sketch.keys()) : new Set();
}

export { newId, refId };
