// Building the finished PDF: pages, your drawings (as PDF layers), comments (as standard
// PDF comments), the watermark and recognised text. Then the permanent blur and the password.
import { libDoc, baseName, FULL, imagePageSize } from "./doc.js";
import { cropUserRect } from "./render.js";
import { pageGeom, mul, inv, apply, rot } from "./geom.js";
import { drawableFor, hexToRgb } from "./shapes.js";
import { wmAppliesTo, wmLayout } from "./watermark.js";
import { filterContent } from "./contentfilter.js";
import { engine } from "./engine.js";
import { layersEdited } from "./layers.js";
import { openSheet, h, esc, icon, busy, toast, segmented } from "./ui.js";
import { canShareFiles, shareFiles, downloadFile, downloadFiles } from "./platform.js";

const IMAGE_MAX = 4096;
const GLYPHLESS_B64 = "AAEAAAAKAIAAAwAgT1MvMkT/RUAAAAEoAAAAYGNtYXAADABzAAABkAAAADRnbHlmAAAAAAAAAcwAAAABaGVhZCzoGYwAAACsAAAANmhoZWED6QH2AAAA5AAAACRobXR4AfQAAAAAAYgAAAAGbG9jYQAAAAAAAAHEAAAABm1heHAAAwACAAABCAAAACBuYW1lGZ8ZNAAAAdAAAABycG9zdJ5/ds8AAAJEAAAALQABAAAAAQAARbS6gV8PPPUAAwPoAAAAAObo7FYAAAAA5ujsVgAAAAAAAAAAAAAAAwACAAAAAAAAAAEAAAPoAAAAAAH0AAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAEAAAACAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAwH0AZAABQAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAPz8/PwAAACAAIAPoAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAAgAAAB9AAAAAAAAAAAAAIAAAADAAAAFAADAAEAAAAUAAQAIAAAAAQABAABAAAAIP//AAAAIP///+EAAQAAAAAAAAAAAAAAAAAAAAAAAAAEADYAAQAAAAAAAQANAAAAAQAAAAAAAgAHAA0AAwABBAkAAQAaABQAAwABBAkAAgAOAC5HbHlwaExlc3NGb250UmVndWxhcgBHAGwAeQBwAGgATABlAHMAcwBGAG8AbgB0AFIAZQBnAHUAbABhAHIAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAECBmdseXBoMQAAAA==";
const MARKUP_SUBTYPES = new Set(["Text", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink", "Popup", "FileAttachment", "Sound", "Redact"]);

const fmt = (v) => (Math.abs(v) < 1e-7 ? "0" : String(+v.toFixed(3)));
const rgbStr = (hex) => hexToRgb(hex).map(fmt).join(" ");

function refFromId(id) {
  const m = /^(\d+)R(\d+)?$/.exec(id);
  return m ? window.PDFLib.PDFRef.of(Number(m[1]), m[2] ? Number(m[2]) : 0) : null;
}

function pageTreeRefs(lib) {
  const { PDFName, PDFArray, PDFRef, PDFDict } = window.PDFLib;
  const out = [];
  const root = lib.catalog.get(PDFName.of("Pages"));
  const visit = (ref, depth) => {
    if (!(ref instanceof PDFRef) || depth > 64) return;
    const node = lib.context.lookup(ref);
    if (!(node instanceof PDFDict)) return;
    const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (!kids) return;
    out.push(ref);
    for (const k of kids.asArray()) visit(k, depth + 1);
  };
  visit(root, 0);
  return out;
}

async function embedPhoto(out, s, crop) {
  const full = crop.x0 <= 0 && crop.y0 <= 0 && crop.x1 >= 1 && crop.y1 >= 1;
  if (full && Math.max(s.w, s.h) <= IMAGE_MAX) {
    if (s.imageType === "jpeg" && s.orientation === 1) return out.embedJpg(await s.blob.arrayBuffer());
    if (s.imageType === "png") return out.embedPng(await s.blob.arrayBuffer());
  }
  const bmp = await createImageBitmap(s.blob, { imageOrientation: "from-image" });
  const sx = crop.x0 * bmp.width, sy = crop.y0 * bmp.height;
  const sw = (crop.x1 - crop.x0) * bmp.width, sh = (crop.y1 - crop.y0) * bmp.height;
  const k = Math.min(1, IMAGE_MAX / Math.max(sw, sh));
  const cw = Math.max(1, Math.round(sw * k)), ch = Math.max(1, Math.round(sh * k));
  const canvas = new OffscreenCanvas(cw, ch);
  const g = canvas.getContext("2d");
  const lossless = s.imageType === "png" || s.imageType === "gif" || s.imageType === "bmp";
  if (!lossless) { g.fillStyle = "#fff"; g.fillRect(0, 0, cw, ch); }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, cw, ch);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: lossless ? "image/png" : "image/jpeg", quality: 0.9 });
  const bytes = await blob.arrayBuffer();
  return lossless ? out.embedPng(bytes) : out.embedJpg(bytes);
}

function pdfDate(ms) {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
}

// Text drawn as a picture, for letters the built-in PDF fonts can't show (Telugu, Hindi…).
async function textImage(text, color, bold) {
  const px = 96;
  const c = new OffscreenCanvas(8, 8);
  let g = c.getContext("2d");
  const font = `${bold ? 700 : 400} ${px}px "Noto Sans", "Noto Sans Telugu", "Noto Sans Devanagari", sans-serif`;
  g.font = font;
  const w = Math.max(4, Math.ceil(g.measureText(text).width) + 8);
  const hgt = Math.ceil(px * 1.3);
  c.width = w;
  c.height = hgt;
  g = c.getContext("2d");
  g.font = font;
  g.fillStyle = color;
  g.textBaseline = "middle";
  g.fillText(text, 4, hgt / 2);
  const blob = await c.convertToBlob({ type: "image/png" });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), aspect: w / hgt };
}

/** Collects resources (fonts, transparency, images, layers) into a PDF resource dictionary. */
class Res {
  constructor(B, dict) {
    this.B = B;
    this.dict = dict;
    this.cache = new Map();
  }
  sub(name) {
    const { PDFName, PDFDict } = window.PDFLib;
    let d = this.dict.lookupMaybe(PDFName.of(name), PDFDict);
    if (!d) { d = this.B.ctx.obj({}); this.dict.set(PDFName.of(name), d); }
    return d;
  }
  add(kind, tag, value, cacheKey) {
    if (cacheKey && this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const d = this.sub(kind);
    const key = d.uniqueKey(tag);
    d.set(key, value);
    const s = key.toString();
    if (cacheKey) this.cache.set(cacheKey, s);
    return s;
  }
  font(f) { return this.add("Font", "TPTF", f.ref, "font:" + f.ref.toString()); }
  gs(strokeA, fillA, multiply) {
    const k = `gs:${strokeA}:${fillA}:${multiply}`;
    if (this.cache.has(k)) return this.cache.get(k);
    const o = { Type: "ExtGState" };
    if (strokeA != null) o.CA = strokeA;
    if (fillA != null) o.ca = fillA;
    if (multiply) o.BM = "Multiply";
    return this.add("ExtGState", "TPTG", this.B.ctx.obj(o), k);
  }
  xobj(ref) { return this.add("XObject", "TPTI", ref, "x:" + ref.toString()); }
  prop(ref) { return this.add("Properties", "TPTL", ref, "p:" + ref.toString()); }
}

/** Writes drawing instructions, with the base -> PDF transform m. */
async function drawableOps(B, R, d, m) {
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  let s = "";
  const path = (cmds) => {
    let o = "";
    for (const c of cmds) {
      if (c[0] === "M" || c[0] === "L") { const [x, y] = apply(m, c[1], c[2]); o += `${fmt(x)} ${fmt(y)} ${c[0] === "M" ? "m" : "l"}\n`; }
      else if (c[0] === "C") {
        const a = apply(m, c[1], c[2]), b = apply(m, c[3], c[4]), e = apply(m, c[5], c[6]);
        o += `${fmt(a[0])} ${fmt(a[1])} ${fmt(b[0])} ${fmt(b[1])} ${fmt(e[0])} ${fmt(e[1])} c\n`;
      } else if (c[0] === "Z") o += "h\n";
    }
    return o;
  };
  for (const p of d.paths) {
    if (p.fill) {
      const a = p.fillOpacity ?? 1;
      s += "q\n" + (a < 1 ? `${R.gs(null, a, false)} gs\n` : "") + `${rgbStr(p.fill)} rg\n` + path(p.cmds) + "f\nQ\n";
    }
    if (p.stroke) {
      const a = p.opacity ?? 1;
      s += "q\n" + (a < 1 || p.multiply ? `${R.gs(a, null, !!p.multiply)} gs\n` : "") +
        `${rgbStr(p.stroke)} RG ${fmt(p.w * scale)} w ${p.cap === "butt" ? 0 : 1} J 1 j\n` +
        (p.dash ? `[${fmt(p.dash[0] * scale)} ${fmt(p.dash[1] * scale)}] 0 d\n` : "") + path(p.cmds) + "S\nQ\n";
    }
  }
  for (const t of d.texts) s += await textOps(B, R, t, m);
  return s;
}

async function textOps(B, R, t, m) {
  if (!t.text) return "";
  const font = t.bold ? B.helvB : B.helv;
  let hex = null;
  try { hex = font.encodeText(t.text).toString(); } catch (e) { hex = null; }
  if (hex) {
    const w = font.widthOfTextAtSize(t.text, t.size);
    const x0 = t.anchor === "start" ? t.x : t.x - w / 2;
    const yb = t.y + t.size * 0.35;
    const tm = mul(m, [1, 0, 0, -1, x0, yb]);
    return `BT ${R.font(font)} ${fmt(t.size)} Tf ${tm.map(fmt).join(" ")} Tm ${rgbStr(t.color)} rg ${hex} Tj ET\n`;
  }
  const img = await textImage(t.text, t.color, t.bold);
  const ref = (await B.out.embedPng(img.bytes)).ref;
  const hgt = t.size * 1.3, w = hgt * img.aspect;
  const x0 = t.anchor === "start" ? t.x : t.x - w / 2;
  const cm = mul(m, [w, 0, 0, -hgt, x0, t.y + hgt / 2]);
  return `q ${cm.map(fmt).join(" ")} cm ${R.xobj(ref)} Do Q\n`;
}

function glyphlessFont(B) {
  if (B.glyphless) return B.glyphless;
  const { ctx } = B;
  const { PDFString } = window.PDFLib;
  const ttf = Uint8Array.from(atob(GLYPHLESS_B64), (c) => c.charCodeAt(0));
  const file = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
  const desc = ctx.register(ctx.obj({ Type: "FontDescriptor", FontName: "GlyphLessFont", Flags: 5, FontBBox: [0, 0, 500, 1000], ItalicAngle: 0, Ascent: 1000, Descent: 0, CapHeight: 1000, StemV: 80, FontFile2: file }));
  const map = new Uint8Array(131072);
  for (let i = 1; i < map.length; i += 2) map[i] = 1;
  const cidToGid = ctx.register(ctx.flateStream(map));
  const cid = ctx.register(ctx.obj({
    Type: "Font", Subtype: "CIDFontType2", BaseFont: "GlyphLessFont",
    CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
    FontDescriptor: desc, DW: 500, CIDToGIDMap: cidToGid
  }));
  let cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def /CMapType 2 def\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n";
  for (let b = 0; b < 256; b += 100) {
    const n = Math.min(100, 256 - b);
    cmap += `${n} beginbfrange\n`;
    for (let i = b; i < b + n; i++) {
      const hh = i.toString(16).padStart(2, "0").toUpperCase();
      cmap += `<${hh}00> <${hh}FF> <${hh}00>\n`;
    }
    cmap += "endbfrange\n";
  }
  cmap += "endcmap CMapName currentdict /CMap defineresource pop end end\n";
  const tu = ctx.register(ctx.flateStream(cmap));
  B.glyphless = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "GlyphLessFont", Encoding: "Identity-H", DescendantFonts: [cid], ToUnicode: tu }));
  return B.glyphless;
}

function ocrOps(B, R, ocr, m) {
  const key = R.add("Font", "TPTO", B.glyphless || glyphlessFont(B), "ocrfont");
  let s = "BT 3 Tr\n";
  for (const w of ocr.words) {
    const chars = [...w.t].filter((ch) => ch.codePointAt(0) <= 0xffff);
    if (!chars.length) continue;
    const hgt = Math.max(0.1, w.y1 - w.y0);
    const hx = (w.x1 - w.x0) / (chars.length * 0.5);
    const tm = mul(m, [hx, 0, 0, -hgt, w.x0, w.y1 - hgt * 0.2]);
    const hex = chars.map((ch) => ch.codePointAt(0).toString(16).padStart(4, "0")).join("");
    s += `${key} 1 Tf ${tm.map(fmt).join(" ")} Tm <${hex}> Tj\n`;
  }
  return s + "ET\n";
}

async function watermarkOps(B, R, spec, d2u, dw, dh) {
  const measure = (text, size) => B.helvB.widthOfTextAtSize(text, size);
  let encodable = true;
  try { B.helvB.encodeText(spec.text || " "); } catch (e) { encodable = false; }
  const L = wmLayout(spec, dw, dh, spec.type === "text" && encodable ? measure : undefined);
  const cos = Math.cos(L.angle), sin = Math.sin(L.angle);
  const gs = R.gs(spec.opacity ?? 0.35, spec.opacity ?? 0.35, false);
  let s = `q ${gs} gs\n`;
  let ref = null, hex = null;
  if (spec.type === "image" && spec.image) {
    const img = spec.image.mime === "image/jpeg" ? await B.out.embedJpg(spec.image.bytes) : await B.out.embedPng(spec.image.bytes);
    ref = R.xobj(img.ref);
  } else if (encodable) {
    hex = B.helvB.encodeText(spec.text || " ").toString();
  } else {
    const ti = await textImage(spec.text, spec.color, true);
    ref = R.xobj((await B.out.embedPng(ti.bytes)).ref);
    L.h = L.fs * 1.3;
    L.w = L.h * ti.aspect;
  }
  for (const [cx, cy] of L.centers) {
    const local = mul(d2u, [cos, sin, -sin, cos, cx, cy]);
    if (hex) {
      const tm = mul(local, [1, 0, 0, -1, -L.w / 2, L.fs * 0.35]);
      s += `BT ${R.font(B.helvB)} ${fmt(L.fs)} Tf ${tm.map(fmt).join(" ")} Tm ${rgbStr(spec.color)} rg ${hex} Tj ET\n`;
    } else {
      const cm = mul(local, [L.w, 0, 0, -L.h, -L.w / 2, L.h / 2]);
      s += `q ${cm.map(fmt).join(" ")} cm ${ref} Do Q\n`;
    }
  }
  return s + "Q\n";
}

/* ---------- comments as standard PDF annotations ---------- */

async function addComment(B, leaf, pageRef, item, unit, m) {
  const { PDFName, PDFHexString, PDFString, PDFArray } = window.PDFLib;
  const { ctx } = B;
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const d = drawableFor(item, unit);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of d.paths) for (const c of p.cmds) for (let i = 1; i < c.length; i += 2) { const q = apply(m, c[i], c[i + 1]); grow(q[0], q[1]); }
  const pad = item.w * scale * 1.5 + 1;
  const rect = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  const apRes = ctx.obj({});
  const R = new Res(B, apRes);
  const ops = await drawableOps(B, R, d, m);
  const ap = ctx.register(ctx.flateStream(ops, { Type: "XObject", Subtype: "Form", BBox: rect, Resources: apRes }));
  const rgb = hexToRgb(item.color);
  const o = {
    Type: "Annot", Rect: rect, F: 4, P: pageRef,
    Contents: PDFHexString.fromText(item.text || ""),
    T: PDFHexString.fromText(item.author || ""),
    NM: PDFString.of(item.id),
    M: PDFString.of(pdfDate(item.modified)),
    CreationDate: PDFString.of(pdfDate(item.created)),
    C: rgb,
    BS: { Type: "Border", W: item.w * scale, S: "S" },
    AP: { N: ap }
  };
  if (item.ctype === "box") {
    const a = apply(m, item.x0, item.y0), b = apply(m, item.x1, item.y1);
    const sq = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    o.Subtype = "Square";
    o.Subj = PDFHexString.fromText("Box");
    o.RD = [sq[0] - rect[0], rect[3] - sq[3], rect[2] - sq[2], sq[1] - rect[1]];
    if (item.cloud) o.BE = { S: "C", I: 1 };
  } else if (item.ctype === "free") {
    o.Subtype = "Polygon";
    o.Subj = PDFHexString.fromText("Freehand");
    const v = [];
    for (let i = 0; i < item.pts.length; i += 2) { const q = apply(m, item.pts[i], item.pts[i + 1]); v.push(q[0], q[1]); }
    o.Vertices = v;
    if (item.cloud) o.BE = { S: "C", I: 1 };
  } else {
    const a = apply(m, item.ax, item.ay);
    const t0 = apply(m, item.tx, item.ty), t1 = apply(m, item.tx + item.tw, item.ty + item.th);
    const box = [Math.min(t0[0], t1[0]), Math.min(t0[1], t1[1]), Math.max(t0[0], t1[0]), Math.max(t0[1], t1[1])];
    o.Subtype = "FreeText";
    o.IT = "FreeTextCallout";
    o.Subj = PDFHexString.fromText("Leader");
    const knee = [Math.max(box[0], Math.min(a[0], box[2])), Math.max(box[1], Math.min(a[1], box[3]))];
    o.CL = [a[0], a[1], knee[0], knee[1]];
    o.LE = "OpenArrow";
    o.DA = PDFString.of(`${rgbStr(item.color)} rg /Helv ${fmt(item.fs * scale)} Tf`);
    o.RD = [box[0] - rect[0], rect[3] - box[3], rect[2] - box[2], box[1] - rect[1]];
  }
  leaf.addAnnot(ctx.register(ctx.obj(o)));
}

/* ---------- hidden layers ---------- */

function makeOcHidden(ctx, hidden) {
  const { PDFName, PDFDict, PDFArray, PDFRef } = window.PDFLib;
  const isOff = (ref) => hidden.has(ref.toString());
  return (v) => {
    const obj = v instanceof PDFRef ? ctx.lookup(v) : v;
    if (!(obj instanceof PDFDict)) return false;
    const type = obj.get(PDFName.of("Type"));
    if (type && type.toString() === "/OCMD") {
      let list = obj.get(PDFName.of("OCGs"));
      list = list instanceof PDFRef && !(ctx.lookup(list) instanceof PDFArray) ? [list] : (ctx.lookupMaybe(list, PDFArray) || { asArray: () => [] }).asArray();
      const refs = list.filter((x) => x instanceof PDFRef);
      if (!refs.length) return false;
      const P = (obj.get(PDFName.of("P")) || "").toString() || "/AnyOn";
      const on = refs.map((r) => !isOff(r));
      let visible;
      if (P === "/AllOn") visible = on.every(Boolean);
      else if (P === "/AnyOff") visible = on.some((x) => !x);
      else if (P === "/AllOff") visible = on.every((x) => !x);
      else visible = on.some(Boolean);
      return !visible;
    }
    return v instanceof PDFRef ? isOff(v) : false;
  };
}

function decodeStream(stream) {
  const L = window.PDFLib;
  if (stream instanceof L.PDFRawStream) return L.decodePDFRawStream(stream).decode();
  if (stream.getUnencodedContents) return stream.getUnencodedContents();
  return stream.getContents();
}

function streamDictEntries(stream) {
  const { PDFName } = window.PDFLib;
  const o = {};
  for (const [k, v] of stream.dict.entries()) {
    const name = k.toString().replace(/^\//, "");
    if (name === "Filter" || name === "DecodeParms" || name === "Length") continue;
    o[name] = v;
  }
  return o;
}

function stripHidden(ctx, leaf, ocHidden, visited) {
  const { PDFName, PDFDict, PDFArray, PDFRef } = window.PDFLib;
  const filterWith = (bytes, res) => {
    const props = res && res.lookupMaybe(PDFName.of("Properties"), PDFDict);
    const xobjs = res && res.lookupMaybe(PDFName.of("XObject"), PDFDict);
    return filterContent(bytes, (name) => {
      const v = props && props.get(PDFName.of(name));
      return v ? ocHidden(v) : false;
    }, (name) => {
      const ref = xobjs && xobjs.get(PDFName.of(name));
      if (!ref) return "keep";
      const x = ctx.lookup(ref);
      if (!x || !x.dict) return "keep";
      const oc = x.dict.get(PDFName.of("OC"));
      if (oc && ocHidden(oc)) return "drop";
      const sub = x.dict.get(PDFName.of("Subtype"));
      if (sub && sub.toString() === "/Form" && ref instanceof PDFRef && !visited.has(ref.toString())) {
        visited.add(ref.toString());
        try {
          const own = x.dict.lookupMaybe(PDFName.of("Resources"), PDFDict) || res;
          const nb = filterWith(decodeStream(x), own);
          if (nb) ctx.assign(ref, ctx.flateStream(nb, streamDictEntries(x)));
        } catch (e) { /* leave it */ }
      }
      return "keep";
    });
  };
  const res = leaf.lookupMaybe(PDFName.of("Resources"), PDFDict);
  const cRef = leaf.get(PDFName.of("Contents"));
  const cObj = cRef ? ctx.lookup(cRef) : null;
  const streams = cObj instanceof PDFArray ? cObj.asArray().map((r) => ctx.lookup(r)) : cObj ? [cObj] : [];
  if (streams.length) {
    const parts = streams.map((s) => decodeStream(s));
    let len = 0;
    for (const p of parts) len += p.length + 1;
    const all = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; all[o++] = 0x0a; }
    const nb = filterWith(all, res);
    if (nb) leaf.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(nb)));
  }
  const annots = leaf.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (annots) {
    const keep = annots.asArray().filter((r) => {
      const a = ctx.lookup(r);
      const oc = a && a.get && a.get(PDFName.of("OC"));
      return !(oc && ocHidden(oc));
    });
    leaf.set(PDFName.of("Annots"), ctx.obj(keep));
  }
}

function stripMarkupAnnots(ctx, leaf) {
  const { PDFName, PDFArray, PDFDict } = window.PDFLib;
  const annots = leaf.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) return;
  const keep = annots.asArray().filter((r) => {
    const a = ctx.lookupMaybe(r, PDFDict);
    const st = a && a.get(PDFName.of("Subtype"));
    return !(st && MARKUP_SUBTYPES.has(st.toString().slice(1)));
  });
  leaf.set(PDFName.of("Annots"), ctx.obj(keep));
}

function filterOrder(ctx, arr, hidden) {
  const { PDFArray, PDFRef } = window.PDFLib;
  const out = [];
  for (const v of arr) {
    if (v instanceof PDFRef) {
      const o = ctx.lookup(v);
      if (o instanceof PDFArray) {
        const sub = filterOrder(ctx, o.asArray(), hidden);
        if (sub.length) out.push(ctx.obj(sub));
      } else if (!hidden.has(v.toString())) out.push(v);
    } else if (v instanceof PDFArray) {
      const sub = filterOrder(ctx, v.asArray(), hidden);
      const hasRef = sub.some((x) => x instanceof PDFRef || x instanceof PDFArray);
      if (hasRef) out.push(ctx.obj(sub));
    } else out.push(v);
  }
  return out;
}

/**
 * Make a new PDF from the given pages.
 * layers: "all" keeps every layer (your on/off choices become the default), "visible" leaves hidden layers out.
 * comments: include comments.
 * Returns { bytes, blurs } — blurs are applied by finishPdf.
 */
export async function buildPdf(doc, pages, { layers = "all", comments = true, title = "" } = {}) {
  const L = window.PDFLib;
  const { PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFNull, PDFObjectCopier, PDFPage, PDFHexString, PDFRef, StandardFonts, degrees } = L;
  const out = await PDFDocument.create({ updateMetadata: false });
  const ctx = out.context;
  const B = { out, ctx, helv: await out.embedFont(StandardFonts.Helvetica), helvB: await out.embedFont(StandardFonts.HelveticaBold), glyphless: null };
  const visibleOnly = layers === "visible";
  const states = new Map();
  const used = [];
  for (const p of pages) {
    const s = doc.src(p);
    if (!states.has(s.id)) { states.set(s.id, { s, firstRef: null }); used.push(s); }
  }
  for (const s of used) {
    if (s.kind !== "pdf") continue;
    const st = states.get(s.id);
    st.lib = await libDoc(s);
    st.copier = PDFObjectCopier.for(st.lib.context, ctx);
    st.srcPages = st.lib.getPages();
    st.newRefs = new Map();
    st.placed = new Set();
    for (const p of pages) if (p.src === s.id && !st.newRefs.has(p.index)) st.newRefs.set(p.index, ctx.nextRef());
    const tm = st.copier.traversedObjects;
    for (const r of pageTreeRefs(st.lib)) tm.set(r, PDFNull);
    st.srcPages.forEach((pg, i) => tm.set(pg.ref, st.newRefs.get(i) || PDFNull));
    st.hiddenOut = new Set();
  }

  const visited = new Set();
  const photoCache = new Map();
  const blurs = [];
  const overlays = [];
  const drawLayerVisible = new Map(doc.layers.map((l) => [l.id, l.visible]));
  const usedLayers = new Set();
  const layerRefs = new Map();
  const layerRef = (id) => {
    if (!layerRefs.has(id)) {
      const l = doc.layer(id);
      layerRefs.set(id, ctx.register(ctx.obj({ Type: "OCG", Name: PDFHexString.fromText(l ? l.name : "Drawing") })));
    }
    return layerRefs.get(id);
  };

  for (let pi = 0; pi < pages.length; pi++) {
    const p = pages[pi];
    const s = doc.src(p);
    const st = states.get(s.id);
    let page, m;
    if (s.kind === "pdf") {
      const leaf = st.copier.copy(st.srcPages[p.index].node);
      let ref = st.newRefs.get(p.index);
      if (st.placed.has(p.index)) ref = ctx.nextRef();
      st.placed.add(p.index);
      ctx.assign(ref, leaf);
      const info = s.pages[p.index];
      const R = (((info.rotate + p.rot) % 360) + 360) % 360;
      leaf.set(PDFName.of("Rotate"), PDFNumber.of(R));
      if (p.crop) leaf.set(PDFName.of("CropBox"), ctx.obj(cropUserRect(info.view, p.crop)));
      if (s.oc && visibleOnly) {
        for (const [id, grp] of s.oc) {
          if (grp.visible) continue;
          const mapped = st.copier.traversedObjects.get(refFromId(id));
          if (mapped && mapped !== PDFNull) st.hiddenOut.add(mapped.toString());
        }
        if (st.hiddenOut.size) stripHidden(ctx, leaf, makeOcHidden(ctx, st.hiddenOut), visited);
      }
      if (!comments) stripMarkupAnnots(ctx, leaf);
      page = PDFPage.of(leaf, ref, out);
      out.addPage(page);
      if (!st.firstRef) st.firstRef = ref;
      const uu = info.userUnit || 1;
      m = [1 / uu, 0, 0, -1 / uu, info.view[0], info.view[3]];
    } else if (s.kind === "image") {
      const crop = p.crop || FULL;
      const ck = `${s.id}:${crop.x0},${crop.y0},${crop.x1},${crop.y1}`;
      let img = photoCache.get(ck);
      if (!img) { img = await embedPhoto(out, s, crop); photoCache.set(ck, img); }
      const { W, H, R } = doc.base(p);
      const cs = doc.contentSize(p);
      const ps = imagePageSize(cs.w, cs.h, doc.imageFit);
      const turned = R % 180 === 90;
      const pw = turned ? ps.h : ps.w;
      const ph = turned ? ps.w : ps.h;
      const uw = (crop.x1 - crop.x0) * W;
      const uh = (crop.y1 - crop.y0) * H;
      const k = Math.min(pw / uw, ph / uh);
      const ox = (pw - uw * k) / 2, oy = (ph - uh * k) / 2;
      page = out.addPage([pw, ph]);
      page.drawImage(img, { x: ox, y: oy, width: uw * k, height: uh * k });
      if (R) page.setRotation(degrees(R));
      if (!st.firstRef) st.firstRef = page.ref;
      m = [k, 0, 0, -k, ox - crop.x0 * W * k, oy + uh * k + crop.y0 * H * k];
    } else {
      page = out.addPage([s.w, s.h]);
      if (p.rot) page.setRotation(degrees(((p.rot % 360) + 360) % 360));
      if (!st.firstRef) st.firstRef = page.ref;
      m = [1, 0, 0, -1, 0, s.h];
    }

    // Everything we add to the page
    const leaf = page.node;
    const g = pageGeom(doc, p);
    const ocr = s.ocr && s.ocr[p.index];
    const wantsWM = doc.watermark && wmAppliesTo(doc.watermark, p.key);
    const marks = p.items.filter((it) => (it.kind === "ink" || it.kind === "shape") && (!visibleOnly || drawLayerVisible.get(it.layer) !== false));
    if (marks.length || wantsWM || (ocr && ocr.words.length) || (comments && p.items.some((it) => it.kind === "comment"))) {
      leaf.normalize();
      const R = new Res(B, leaf.lookup(PDFName.of("Resources"), PDFDict));
      let ops = "";
      if (wantsWM) {
        const d2u = mul(m, inv(g.b2d));
        if (p.items.some((it) => it.kind === "blur")) {
          // Blurring removes everything under it, so the watermark goes on afterwards.
          const wmRes = ctx.obj({});
          const wops = await watermarkOps(B, new Res(B, wmRes), doc.watermark, d2u, g.dw, g.dh);
          const ref = ctx.register(ctx.flateStream(wops, { Type: "XObject", Subtype: "Form", BBox: [-100000, -100000, 100000, 100000], Resources: wmRes }));
          overlays.push({ page: pi, num: ref.objectNumber });
        } else {
          ops += await watermarkOps(B, R, doc.watermark, d2u, g.dw, g.dh);
        }
      }
      const byLayer = new Map();
      for (const it of marks) {
        if (!byLayer.has(it.layer)) byLayer.set(it.layer, []);
        byLayer.get(it.layer).push(it);
      }
      for (const [lid, items] of byLayer) {
        usedLayers.add(lid);
        ops += `/OC ${R.prop(layerRef(lid))} BDC\n`;
        for (const it of items) ops += await drawableOps(B, R, drawableFor(it, g.unit), m);
        ops += "EMC\n";
      }
      if (ocr && ocr.words.length) {
        const om = mul(m, inv(rot(ocr.R || 0, g.W, g.H)));
        ops += ocrOps(B, R, ocr, om);
      }
      if (ops) leaf.addContentStream(ctx.register(ctx.flateStream(ops)));
      if (comments) {
        for (const it of p.items) if (it.kind === "comment") await addComment(B, leaf, page.ref, it, g.unit, m);
      }
    }
    for (const it of p.items) {
      if (it.kind !== "blur") continue;
      const a = apply(m, it.x0, it.y0), b = apply(m, it.x1, it.y1);
      blurs.push({ page: pi, rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
    }
  }

  const pdfSources = used.filter((s) => s.kind === "pdf");
  const single = used.length === 1 && pdfSources.length === 1;

  /* Layers: the PDF's own (e.g. AutoCAD) and yours */
  const layered = pdfSources.filter((s) => s.oc);
  const ocgs = [], on = [], off = [], order = [], rb = [], locked = [], autoState = [];
  let dExtra = null;
  for (const s of layered) {
    const st = states.get(s.id);
    const props = st.lib.catalog.lookupMaybe(PDFName.of("OCProperties"), PDFDict);
    if (!props) continue;
    const copied = st.copier.copy(props);
    const hidden = st.hiddenOut || new Set();
    const list = copied.lookupMaybe(PDFName.of("OCGs"), PDFArray);
    if (list) for (const r of list.asArray()) if (!hidden.has(r.toString())) ocgs.push(r);
    for (const [id, grp] of s.oc) {
      const src = refFromId(id);
      const mapped = src && st.copier.traversedObjects.get(src);
      if (!mapped || mapped === PDFNull || hidden.has(mapped.toString())) continue;
      (grp.visible ? on : off).push(mapped);
    }
    const D = copied.lookupMaybe(PDFName.of("D"), PDFDict);
    const ord = D && D.lookupMaybe(PDFName.of("Order"), PDFArray);
    if (ord) {
      const items = visibleOnly ? filterOrder(ctx, ord.asArray(), hidden) : ord.asArray();
      if (layered.length > 1) { if (items.length) order.push(ctx.obj([PDFHexString.fromText(baseName(s.name)), ...items])); }
      else order.push(...items);
    }
    if (!visibleOnly) {
      const rbg = D && D.lookupMaybe(PDFName.of("RBGroups"), PDFArray);
      if (rbg) rb.push(...rbg.asArray());
      const lk = D && D.lookupMaybe(PDFName.of("Locked"), PDFArray);
      if (lk) locked.push(...lk.asArray());
      const as = D && D.lookupMaybe(PDFName.of("AS"), PDFArray);
      if (as) {
        for (const item of as.asArray()) {
          const dd = ctx.lookup(item);
          const ev = dd instanceof PDFDict ? dd.get(PDFName.of("Event")) : null;
          if (ev && ev.toString() === "/View") continue;
          autoState.push(item);
        }
      }
    }
    if (layered.length === 1 && D) {
      dExtra = {};
      for (const k of ["Name", "Creator", "ListMode", "Intent"]) { const v = D.get(PDFName.of(k)); if (v) dExtra[k] = v; }
    }
  }
  const mine = doc.layers.filter((l) => usedLayers.has(l.id));
  if (mine.length) {
    const refs = mine.map((l) => layerRef(l.id));
    ocgs.push(...refs);
    mine.forEach((l, i) => (l.visible ? on : off).push(refs[i]));
    order.push(ctx.obj([PDFHexString.fromText("Drawings"), ...refs]));
  }
  if (ocgs.length) {
    const D = { ...(dExtra || {}), BaseState: "ON", ON: on, OFF: off };
    if (order.length) D.Order = order;
    if (rb.length) D.RBGroups = rb;
    if (locked.length) D.Locked = locked;
    if (autoState.length) D.AS = autoState;
    out.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: ocgs, D: ctx.obj(D) }));
    out.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOC"));
  }

  /* Bookmarks */
  if (single) {
    const st = states.get(pdfSources[0].id);
    const cat = st.lib.catalog;
    for (const key of ["Outlines", "Dests", "AcroForm"]) {
      const v = cat.get(PDFName.of(key));
      if (v) out.catalog.set(PDFName.of(key), st.copier.copy(v));
    }
    const names = cat.lookupMaybe(PDFName.of("Names"), PDFDict);
    const dests = names && names.get(PDFName.of("Dests"));
    if (dests) out.catalog.set(PDFName.of("Names"), ctx.obj({ Dests: st.copier.copy(dests) }));
    if (!ocgs.length) {
      for (const key of ["PageMode", "PageLayout"]) {
        const v = cat.get(PDFName.of(key));
        if (v instanceof PDFName) out.catalog.set(PDFName.of(key), v);
      }
    }
  } else if (used.length > 1) {
    const marksList = used.filter((s) => states.get(s.id).firstRef && s.kind !== "blank");
    if (marksList.length) {
      const rootRef = ctx.nextRef();
      const refs = marksList.map(() => ctx.nextRef());
      marksList.forEach((s, i) => {
        const item = { Title: PDFHexString.fromText(baseName(s.name)), Parent: rootRef, Dest: [states.get(s.id).firstRef, "Fit"] };
        if (i > 0) item.Prev = refs[i - 1];
        if (i < refs.length - 1) item.Next = refs[i + 1];
        ctx.assign(refs[i], ctx.obj(item));
      });
      ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
      out.catalog.set(PDFName.of("Outlines"), rootRef);
    }
  }

  if (title) out.setTitle(title);
  out.setProducer("Tesseract PDF Tools");
  out.setCreator("Tesseract PDF Tools (phone)");
  const now = new Date();
  out.setCreationDate(now);
  out.setModificationDate(now);
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, blurs, overlays };
}

/** The finished file: built, then blurred for good and protected when needed. */
export async function exportPdf(doc, pages, opts = {}, onProgress) {
  const { bytes, blurs, overlays } = await buildPdf(doc, pages, opts);
  if (!blurs.length && !doc.password) return bytes;
  return engine("finalize", [bytes, { blurs, overlays, password: doc.password }], { onProgress, transfer: [bytes.buffer] });
}

/* ---------- Save sheet ---------- */

function cleanName(n) {
  return n.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().replace(/\.pdf$/i, "") || "Document";
}

function pageRangeLabel(doc, pages) {
  const idx = pages.map((p) => doc.pages.indexOf(p) + 1).sort((a, b) => a - b);
  const parts = [];
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    parts.push(i === j ? `${idx[i]}` : `${idx[i]}-${idx[j]}`);
    i = j + 1;
  }
  const s = parts.join(",");
  return s.length > 24 ? `${idx.length} pages` : `page${idx.length > 1 ? "s" : ""} ${s}`;
}

export function formatSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}

export function openSaveSheet(doc, { pages = null, onSaved } = {}) {
  const extract = !!pages;
  const list = pages || doc.pages;
  const readOnly = doc.readOnly;
  const share = canShareFiles();
  const hasPdfLayers = list.some((p) => doc.src(p).oc);
  const hasMyLayers = list.some((p) => p.items.some((it) => it.kind === "ink" || it.kind === "shape"));
  const hasComments = list.some((p) => p.items.some((it) => it.kind === "comment"));
  const hasBlur = list.some((p) => p.items.some((it) => it.kind === "blur"));
  const hasPhotos = list.some((p) => doc.src(p).kind === "image");
  const defaultName = extract ? `${doc.name} - ${pageRangeLabel(doc, list)}` : doc.name;
  let layersMode = "all";
  let includeComments = true;

  const body = h(`<div>
    ${readOnly ? `<p class="warn">This PDF is password-protected and couldn't be unlocked here, so it's shared as it is. Connect to the internet once to unlock it for editing.</p>` : ""}
    <label class="field"><span>File name</span>
      <span class="namefield"><input class="input" name="fname" autocomplete="off" spellcheck="false" enterkeyhint="done"><em>.pdf</em></span>
    </label>
    <div data-layers></div>
    <div data-comments></div>
    <div data-fit></div>
    <ul class="save-notes"></ul>
  </div>`);
  body.querySelector("[name=fname]").value = defaultName;
  const notes = body.querySelector(".save-notes");
  const note = (t) => notes.appendChild(h(`<li>${esc(t)}</li>`));

  if (!readOnly && (hasPdfLayers || hasMyLayers)) {
    const box = body.querySelector("[data-layers]");
    box.className = "field";
    box.innerHTML = `<span>Layers</span>`;
    const opts = [
      { value: "all", title: "Keep all layers", text: "Layers you turned off stay off, and can be turned on again later." },
      { value: "visible", title: "Only what's visible", text: "Hidden layers are left out of the saved copy." }
    ];
    for (const o of opts) {
      const row = h(`<label class="radio-card${o.value === layersMode ? " on" : ""}"><input type="radio" name="layers" value="${o.value}"${o.value === layersMode ? " checked" : ""}><span><b>${esc(o.title)}</b><small>${esc(o.text)}</small></span></label>`);
      row.querySelector("input").addEventListener("change", () => {
        layersMode = o.value;
        box.querySelectorAll(".radio-card").forEach((r) => r.classList.toggle("on", r === row));
        forget();
      });
      box.appendChild(row);
    }
  }
  if (!readOnly && hasComments) {
    const sw = h(`<button type="button" role="switch" aria-checked="true" class="switch-row"><span class="switch on"></span><span><span>Include comments</span><small>They show in Acrobat, Chrome and Edge too.</small></span></button>`);
    sw.addEventListener("click", () => {
      includeComments = !includeComments;
      sw.setAttribute("aria-checked", includeComments);
      sw.querySelector(".switch").classList.toggle("on", includeComments);
      forget();
    });
    body.querySelector("[data-comments]").appendChild(sw);
  }
  if (!readOnly && hasPhotos) {
    const f = body.querySelector("[data-fit]");
    f.className = "field";
    f.innerHTML = `<span>Photo page size</span>`;
    f.appendChild(segmented([{ value: "a4", label: "A4" }, { value: "a3", label: "A3" }, { value: "fit", label: "Fit photo" }], doc.imageFit, (v) => {
      if (v === doc.imageFit) return;
      doc.commit();
      doc.imageFit = v;
      doc.changed({ fit: true });
      forget();
    }));
  }
  if (!readOnly && doc.password) note("It will have a password. Change it in Tools, Password.");
  if (!readOnly && hasBlur) note("Blurred areas are removed for good in the saved file.");
  note(`${list.length} page${list.length === 1 ? "" : "s"}${extract ? " selected" : ""}.`);

  const foot = h(`<div class="foot-row">
    ${share ? `<button class="btn primary" type="button" data-go="share">${icon("share")}<span>Share</span></button>` : ""}
    <button class="btn ${share ? "" : "primary"}" type="button" data-go="download">${icon("download")}<span>Download</span></button>
  </div>`);
  const sheet = openSheet({ title: extract ? "Extract pages" : "Save PDF", body, foot });

  let ready = null;
  function forget() {
    ready = null;
    const sb = foot.querySelector('[data-go="share"] span');
    if (sb) sb.textContent = "Share";
  }
  body.addEventListener("input", forget);

  async function make() {
    const name = cleanName(body.querySelector("[name=fname]").value) + ".pdf";
    if (ready && ready.name === name) return ready;
    if (readOnly) {
      const s = doc.src(list[0]);
      ready = new File([s.bytes], name, { type: "application/pdf" });
      return ready;
    }
    const b = busy(extract ? "Extracting pages…" : "Making your PDF…");
    try {
      const bytes = await exportPdf(doc, list, { layers: layersMode, comments: includeComments, title: name.replace(/\.pdf$/i, "") }, (t) => b.set(t));
      ready = new File([bytes], name, { type: "application/pdf" });
      return ready;
    } finally {
      b.close();
    }
  }

  foot.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-go]");
    if (!btn) return;
    let file;
    try {
      file = await make();
    } catch (err) {
      console.error(err);
      toast(err && err.code === "offline" ? err.message : "The PDF couldn't be made. Try again, or try with fewer pages.", { ms: 6000 });
      return;
    }
    if (btn.dataset.go === "download") {
      downloadFile(file);
      if (!extract) doc.dirty = false;
      sheet.close();
      toast(`Saved to Downloads as ${file.name}`);
      onSaved && onSaved();
      return;
    }
    const r = await shareFiles([file], file.name).catch(() => "failed");
    if (r === "shared") {
      if (!extract) doc.dirty = false;
      sheet.close();
      onSaved && onSaved();
    } else if (r === "needs-tap") {
      btn.querySelector("span").textContent = "Share now";
      toast("Your PDF is ready. Tap Share now.");
    } else if (r === "failed") {
      toast("Sharing didn't work. Use Download instead.");
    }
  });
  return sheet;
}

/** A sheet for finished files from a tool (split PDFs, images, text). */
export function openResultSheet(title, files, message) {
  const share = canShareFiles(files.slice(0, 1));
  const many = files.length > 1;
  const body = h(`<div>${message ? `<p class="note" style="margin-top:0">${esc(message)}</p>` : ""}<ul class="file-list"></ul></div>`);
  const ul = body.querySelector("ul");
  for (const f of files.slice(0, 60)) {
    ul.appendChild(h(`<li>${icon(f.type.startsWith("image/") ? "image" : f.type === "text/plain" ? "textfile" : "file")}<span>${esc(f.name)}</span><small>${formatSize(f.size)}</small></li>`));
  }
  if (files.length > 60) ul.appendChild(h(`<li><span>and ${files.length - 60} more</span></li>`));
  const foot = h(`<div class="foot-row">
    ${share ? `<button class="btn primary" type="button" data-go="share">${icon("share")}<span>${many ? "Share all" : "Share"}</span></button>` : ""}
    <button class="btn ${share ? "" : "primary"}" type="button" data-go="download">${icon("download")}<span>${many ? "Download all" : "Download"}</span></button>
  </div>`);
  const sheet = openSheet({ title, body, foot });
  foot.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-go]");
    if (!btn) return;
    if (btn.dataset.go === "download") {
      await downloadFiles(files);
      sheet.close();
      toast(many ? `Saved ${files.length} files to Downloads` : `Saved to Downloads as ${files[0].name}`);
      return;
    }
    const r = await shareFiles(files, title).catch(() => "failed");
    if (r === "shared") sheet.close();
    else if (r === "needs-tap") toast("Tap Share again.");
    else if (r === "failed") toast("Sharing didn't work. Use Download instead.");
  });
  return sheet;
}

export { layersEdited };
