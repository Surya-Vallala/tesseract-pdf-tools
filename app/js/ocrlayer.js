// Recognised (OCR) text that came inside a PDF: finding it and taking it out again.
//
// The text is invisible and sits over the scanned picture. Both apps write it the same way: its
// own content stream "q /Name Do Q" drawing a form XObject marked /TPTOCR true. Phone versions
// before 1.10 wrote it as "BT 3 Tr … ET" blocks with a /TPTO… glyphless font inside the stream
// that also held the page's other additions; that kind is found and removed too.
import { libDoc } from "./doc.js";

export const OCR_KEY = "TPTOCR";
const LEGACY_FONT = /^\/TPTO(-\d+)?$/; // pdf-lib names it /TPTO-<number>
const LEGACY_BLOCK = /BT 3 Tr\n(?:\/TPTO(?:-\d+)? 1 Tf [^\n]*\n)*ET\n/g;
const DO_ONLY = /^\s*q\s+(\/[^\s/<>[\]()]+)\s+Do\s+Q\s*$/;

function ocrXObjects(ctx, res) {
  const { PDFName, PDFDict } = window.PDFLib;
  const names = new Set();
  const xo = res && res.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xo) return names;
  for (const [k, v] of xo.entries()) {
    try {
      const s = ctx.lookup(v);
      if (s && s.dict && s.dict.get(PDFName.of(OCR_KEY))) names.add(k.toString());
    } catch (e) { /* not a stream */ }
  }
  return names;
}

function hasLegacyFont(res) {
  const { PDFName, PDFDict } = window.PDFLib;
  const fonts = res && res.lookupMaybe(PDFName.of("Font"), PDFDict);
  if (!fonts) return false;
  for (const [k] of fonts.entries()) if (LEGACY_FONT.test(k.toString())) return true;
  return false;
}

function resourcesOf(node) {
  try { return node.Resources(); } catch (e) { return undefined; }
}

/** Page indexes (0-based) of a PDF source that carry recognised text. Cached on the source. */
export async function fileOcrPages(src) {
  if (!src || src.kind !== "pdf") return new Set();
  if (src.ocrPages) return src.ocrPages;
  const out = new Set();
  if (!src.locked) {
    try {
      const lib = await libDoc(src);
      lib.getPages().forEach((pg, i) => {
        const res = resourcesOf(pg.node);
        if (ocrXObjects(lib.context, res).size || hasLegacyFont(res)) out.add(i);
      });
    } catch (e) { console.warn("Looking for recognised text failed", e); }
  }
  src.ocrPages = out;
  return out;
}

function streamText(stream) {
  const { decodePDFRawStream, PDFRawStream } = window.PDFLib;
  const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

/**
 * Takes the recognised text out of a page being saved (a copied page dictionary). Streams that
 * other pages may share are never changed: the page gets a new contents list instead.
 */
export function stripOcrLayer(ctx, leaf) {
  const { PDFName, PDFArray, PDFRef } = window.PDFLib;
  const res = resourcesOf(leaf);
  const forms = ocrXObjects(ctx, res);
  const legacy = hasLegacyFont(res);
  if (!forms.size && !legacy) return false;
  const raw = leaf.get(PDFName.of("Contents"));
  if (!raw) return false;
  const arr = ctx.lookup(raw);
  const refs = arr instanceof PDFArray ? arr.asArray() : [raw];
  const keep = [];
  const dropped = new Set();
  let changed = false, legacyGone = false;
  for (const ref of refs) {
    const stream = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
    let text = null;
    try {
      const size = stream && stream.contents ? stream.contents.length : 0;
      if (stream && (size < 200 && forms.size || legacy && size < 8 * 1024 * 1024)) text = streamText(stream);
    } catch (e) { text = null; }
    if (text != null) {
      const m = DO_ONLY.exec(text);
      if (m && forms.has(m[1])) { changed = true; dropped.add(m[1]); continue; }
      if (legacy && text.includes("/TPTO")) {
        const left = text.replace(LEGACY_BLOCK, "");
        if (left !== text) {
          changed = legacyGone = true;
          if (left.trim()) keep.push(ctx.register(ctx.flateStream(left)));
          continue;
        }
      }
    }
    keep.push(ref);
  }
  if (!changed) return false;
  leaf.set(PDFName.of("Contents"), ctx.obj(keep));
  // and out of the page's resources, so neither app finds it again. Other pages may share these
  // dictionaries, so this page gets its own copies.
  const own = (dict, key) => {
    const v = dict.get(PDFName.of(key));
    const d = v && ctx.lookup(v);
    if (!d || typeof d.clone !== "function") return null;
    const c = d.clone(ctx);
    dict.set(PDFName.of(key), c);
    return c;
  };
  const r = res.clone(ctx);
  leaf.set(PDFName.of("Resources"), r);
  if (dropped.size) {
    const xo = own(r, "XObject");
    if (xo) for (const name of dropped) xo.delete(PDFName.of(name.slice(1)));
  }
  if (legacyGone) {
    const fonts = own(r, "Font");
    if (fonts) for (const [k] of fonts.entries()) if (LEGACY_FONT.test(k.toString())) fonts.delete(k);
  }
  return true;
}
