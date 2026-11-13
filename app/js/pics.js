// Pictures: a photo, scan, logo, signature or a page of a PDF placed on a page as a drawing.
// The same format as the Windows app (pictures.py), so either app can edit a picture the other
// placed:
//   it.w, it.h   the box (points), centred on 0,0 with y going down
//   it.m         box -> base units of the page (the Windows app keeps box -> PDF user space)
//   it.img       { hash, pw, ph, crop: [l, t, r, b], skew: [h, v] (degrees), flip: [h, v],
//                  look: "color" | "grey" | "bw", white, bright, contrast (-100..100), border }
//   it.color, it.width  the border's colour and thickness (points); it.opacity
// The picture itself is kept once per document in doc.pics (hash -> { blob, type, pw, ph }); the
// marks only point at it, so undo stays light.
import { mul, inv, apply, T } from "./geom.js";

export const MAX_PX = 4096;
export const PDF_DPI = 300;
const SCREEN_PX = 2048;
export const DEFAULTS = Object.freeze({ crop: [0, 0, 0, 0], skew: [0, 0], flip: [false, false], look: "color", white: false, bright: 0, contrast: 0, border: false });

export const isPic = (it) => !!it && it.kind === "pic";

/* ---------- settings and geometry ---------- */

/** The picture's settings with defaults filled in (a fresh object). */
export function settingsOf(it) {
  const src = (it && it.img) || {};
  const s = { ...DEFAULTS, ...src };
  s.crop = [...(src.crop || []), 0, 0, 0, 0].slice(0, 4).map((v) => Math.min(0.95, Math.max(0, Number(v) || 0)));
  s.skew = [...(src.skew || []), 0, 0].slice(0, 2).map((v) => Math.max(-75, Math.min(75, Number(v) || 0)));
  s.flip = [...(src.flip || []), false, false].slice(0, 2).map((v) => !!v);
  if (!["color", "grey", "bw"].includes(s.look)) s.look = "color";
  s.white = !!s.white;
  s.border = !!s.border;
  s.bright = Math.round(Math.max(-100, Math.min(100, Number(s.bright) || 0)));
  s.contrast = Math.round(Math.max(-100, Math.min(100, Number(s.contrast) || 0)));
  s.pw = Number(s.pw) || 1;
  s.ph = Number(s.ph) || 1;
  return s;
}

/** Whether the settings change the picture's pixels (not only where and how it is drawn). */
export function changesPixels(s) {
  return s.look !== "color" || s.white || s.bright !== 0 || s.contrast !== 0;
}

const rad = (d) => (d * Math.PI) / 180;

/** The box's slant, applied in its own frame before it.m. */
export function skewMatrix(s) {
  return [1, Math.tan(rad(s.skew[1])), Math.tan(rad(s.skew[0])), 1, 0, 0];
}

/** Box (centred, y down) -> base, slant included. */
export function frameOf(it) {
  return mul(it.m, skewMatrix(settingsOf(it)));
}

/** The four corners in base units: top-left, top-right, bottom-right, bottom-left. */
export function picCorners(it) {
  const F = frameOf(it);
  const w = it.w / 2, h = it.h / 2;
  return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => apply(F, x, y));
}

export function picBounds(it) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of picCorners(it)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

/** A point (base units) in the box's own coordinates. */
export function toBox(it, bx, by) {
  return apply(inv(frameOf(it)), bx, by);
}

/** Is a point (base units) on the picture? tol in base units. */
export function hitPic(it, bx, by, tol = 0) {
  const F = frameOf(it);
  const k = Math.sqrt(Math.abs(F[0] * F[3] - F[1] * F[2])) || 1;
  const [x, y] = apply(inv(F), bx, by);
  const t = tol / k;
  return Math.abs(x) <= it.w / 2 + t && Math.abs(y) <= it.h / 2 + t;
}

/** The picture with its box set to (x0, y0)-(x1, y1) in its own slanted frame (old coordinates). */
export function resized(it, x0, y0, x1, y1) {
  const n = structuredClone(it);
  n.w = Math.max(2, Math.abs(x1 - x0));
  n.h = Math.max(2, Math.abs(y1 - y0));
  const c = apply(skewMatrix(settingsOf(it)), (x0 + x1) / 2, (y0 + y1) / 2); // the centre moves in the slanted frame
  n.m = mul(it.m, T(c[0], c[1]));
  return n;
}

/** The whole original picture in the box's coordinates [x0, y0, x1, y1], for cropping. */
export function fullBox(it) {
  const [l, t, r, b] = settingsOf(it).crop;
  const fw = it.w / Math.max(0.05, 1 - l - r), fh = it.h / Math.max(0.05, 1 - t - b);
  const x0 = -it.w / 2 - l * fw, y0 = -it.h / 2 - t * fh;
  return [x0, y0, x0 + fw, y0 + fh];
}

/** The picture showing another part of the original; what stays shows where it was. */
export function withCrop(it, crop) {
  const s = settingsOf(it);
  const [l0, t0, r0, b0] = s.crop;
  let [l1, t1, r1, b1] = crop.map((v) => Math.min(0.95, Math.max(0, v)));
  if (1 - l1 - r1 < 0.02) r1 = 0.98 - l1;
  if (1 - t1 - b1 < 0.02) b1 = 0.98 - t1;
  const fw = it.w / Math.max(0.05, 1 - l0 - r0), fh = it.h / Math.max(0.05, 1 - t0 - b0);
  const X0 = -it.w / 2 - l0 * fw, Y0 = -it.h / 2 - t0 * fh;
  let a0 = X0 + l1 * fw, a1 = X0 + (1 - r1) * fw, c0 = Y0 + t1 * fh, c1 = Y0 + (1 - b1) * fh;
  // a flipped picture shows its left part on the right: the box follows what is shown
  if (s.flip[0]) [a0, a1] = [-a1, -a0];
  if (s.flip[1]) [c0, c1] = [-c1, -c0];
  const n = resized(it, a0, c0, a1, c1);
  n.img = { ...(n.img || {}), crop: [l1, t1, r1, b1].map((v) => Math.round(v * 1e5) / 1e5) };
  return n;
}

/** The box's angle in base units (degrees, clockwise as shown on an unturned page). */
export function picAngle(it) {
  return ((Math.atan2(it.m[1], it.m[0]) * 180) / Math.PI + 360) % 360;
}

/** The picture turned by deg (clockwise) about its centre. */
export function turned(it, deg) {
  const n = structuredClone(it);
  const a = rad(deg), c = Math.cos(a), s = Math.sin(a);
  const cx = it.m[4], cy = it.m[5];
  n.m = mul(mul(T(cx, cy), [c, s, -s, c, 0, 0]), mul(T(-cx, -cy), it.m));
  return n;
}

export function shiftPic(it, dx, dy) {
  it.m = it.m.slice();
  it.m[4] += dx;
  it.m[5] += dy;
}

/** Back to the picture as placed: no crop, slant, flip, colour change or border, opaque, level
 * on the page as shown, its own proportions (keeping its width and centre). pt: base per point; R: page turn. */
export function resetPic(it, pt, R) {
  const s = settingsOf(it);
  const n = structuredClone(it);
  n.img = { ...(n.img || {}), ...structuredClone(DEFAULTS) };
  n.opacity = 1;
  const c = apply(frameOf(it), 0, 0);
  n.h = (n.w * s.ph) / Math.max(1, s.pw);
  const a = rad((360 - R) % 360), co = Math.cos(a), si = Math.sin(a);
  n.m = [pt * co, pt * si, -pt * si, pt * co, c[0], c[1]];
  return n;
}

/** Size on the paper (points) along the box's sides, and the slant-free scale of its matrix. */
export function paperSize(it, pt) {
  const kx = Math.hypot(it.m[0], it.m[1]) / pt, ky = Math.hypot(it.m[2], it.m[3]) / pt;
  return { w: it.w * kx, h: it.h * ky, kx, ky };
}

/* ---------- the pictures a document holds ---------- */

export function picsOf(doc) {
  if (!doc.pics) doc.pics = new Map();
  return doc.pics;
}

async function hashOf(bytes) {
  try {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
    return [...d].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 20);
  } catch (e) {
    // no crypto.subtle (an old browser over plain http): a weaker id, still stable
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < bytes.length; i++) { h1 = Math.imul(h1 ^ bytes[i], 16777619); h2 = Math.imul(h2 + bytes[i], 2246822519) ^ (h2 >>> 13); }
    return ((h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0") + bytes.length.toString(16).padStart(4, "0")).slice(0, 20);
  }
}

/** Keeps a picture with the document. Returns its hash. */
export async function registerPic(doc, pic, hash = null) {
  const bytes = new Uint8Array(await pic.blob.arrayBuffer());
  const h = hash || (await hashOf(bytes));
  const store = picsOf(doc);
  if (!store.has(h)) store.set(h, { blob: pic.blob, type: pic.type, pw: pic.pw, ph: pic.ph, url: null });
  return h;
}

export function newImgSettings(hash, pic) {
  return { hash, pw: pic.pw, ph: pic.ph, ...structuredClone(DEFAULTS) };
}

/** A first size in points: its printed size (from its dpi, else 150 dpi), at most 60% of the
 * page either way, and at least 15 mm across. */
export function naturalSize(pw, ph, dpi, pageW, pageH) {
  const k = 72 / (dpi || 150);
  let w = pw * k, h = ph * k;
  const lim = Math.min((pageW * 0.6) / w, (pageH * 0.6) / h, 1);
  w *= lim; h *= lim;
  const small = (15 * 72) / 25.4;
  if (Math.max(w, h) < small) { const g = small / Math.max(w, h); w *= g; h *= g; }
  return { w, h };
}

/* ---------- reading picture files ---------- */

export class PictureError extends Error {}

function sniffImage(head) {
  if (head[0] === 0xff && head[1] === 0xd8) return "jpeg";
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
  const str = String.fromCharCode(...head.slice(0, 16));
  if (str.startsWith("GIF8")) return "gif";
  if (str.startsWith("RIFF") && str.slice(8, 12) === "WEBP") return "webp";
  if (str.startsWith("BM")) return "bmp";
  if (str.startsWith("II*\0") || str.startsWith("MM\0*")) return "tiff";
  if (str.slice(4, 8) === "ftyp") {
    const brand = str.slice(8, 12);
    if (/^(avif|avis)/.test(brand)) return "avif";
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand)) return "heic";
  }
  if (str.includes("%PDF-")) return "pdf";
  return null;
}

/** JPEG facts: orientation, colour components, the Adobe marker and the dpi of its JFIF header. */
export function jpegInfo(bytes) {
  const info = { orientation: 1, comps: 3, adobe: false, dpi: null, w: 0, h: 0 };
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 2;
    while (off + 4 < dv.byteLength) {
      if (dv.getUint8(off) !== 0xff) break;
      const marker = dv.getUint8(off + 1);
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { off += 2; continue; }
      const len = dv.getUint16(off + 2);
      if (marker === 0xe0 && dv.getUint32(off + 4) === 0x4a464946) { // JFIF
        const units = dv.getUint8(off + 11), xd = dv.getUint16(off + 12);
        if (units === 1 && xd) info.dpi = xd;
        else if (units === 2 && xd) info.dpi = xd * 2.54;
      } else if (marker === 0xe1 && dv.getUint32(off + 4) === 0x45786966) { // Exif
        const tiff = off + 10;
        const little = dv.getUint16(tiff) === 0x4949;
        const ifd = tiff + dv.getUint32(tiff + 4, little);
        const n = dv.getUint16(ifd, little);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (dv.getUint16(e, little) === 0x0112) info.orientation = dv.getUint16(e + 8, little);
        }
      } else if (marker === 0xee && dv.getUint32(off + 4) === 0x41646f62) { // Adobe
        info.adobe = true;
      } else if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        info.h = dv.getUint16(off + 5);
        info.w = dv.getUint16(off + 7);
        info.comps = dv.getUint8(off + 9);
        break;
      } else if (marker === 0xda) break;
      off += 2 + len;
    }
  } catch (e) { /* what we have so far */ }
  return info;
}

function pngDpi(bytes) {
  try {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let off = 8;
    while (off + 12 <= dv.byteLength) {
      const len = dv.getUint32(off);
      const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
      if (type === "pHYs" && len >= 9) {
        const ppx = dv.getUint32(off + 8), unit = dv.getUint8(off + 16);
        return unit === 1 && ppx ? ppx * 0.0254 : null;
      }
      if (type === "IDAT" || type === "IEND") return null;
      off += 12 + len;
    }
  } catch (e) { /* none */ }
  return null;
}

function canvasOf(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

async function blobOf(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((r) => canvas.toBlob(r, type, quality));
}

function hasAlpha(canvas) {
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

/** A picture file, ready to place: { blob, type: "jpeg" | "png", pw, ph, dpi }. */
export async function pictureFromFile(file) {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const kind = sniffImage(head);
  if (kind === "heic") throw new PictureError("This is a HEIC photo, which the phone's browser can't read. Share it as JPEG, or set the camera to JPEG.");
  if (kind === "pdf") throw new PictureError("pdf");
  if (!kind) throw new PictureError("This file isn't a picture the app can read.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let dpi = null;
  let info = null;
  if (kind === "jpeg") { info = jpegInfo(bytes); dpi = info.dpi; } else if (kind === "png") dpi = pngDpi(bytes);
  if (dpi && dpi < 30) dpi = null;
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    throw new PictureError(kind === "tiff" ? "TIFF pictures can't be read on the phone. Use JPG or PNG." : "This picture couldn't be read.");
  }
  const W = bmp.width, H = bmp.height;
  // a plain JPEG goes in as it is: no loss
  if (kind === "jpeg" && info.orientation === 1 && Math.max(W, H) <= MAX_PX && (info.comps === 3 || info.comps === 1)) {
    bmp.close();
    return { blob: new Blob([bytes], { type: "image/jpeg" }), type: "jpeg", pw: W, ph: H, dpi };
  }
  const k = Math.min(1, MAX_PX / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
  const c = canvasOf(w, h);
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  if (kind === "jpeg") { g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); }
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const jpeg = kind === "jpeg" || (kind === "webp" && !hasAlpha(c));
  const blob = await blobOf(c, jpeg ? "image/jpeg" : "image/png", 0.9);
  if (dpi && k < 1) dpi *= k;
  return { blob, type: jpeg ? "jpeg" : "png", pw: w, ph: h, dpi };
}

/** A page of a PDF source drawn as a picture, at PDF_DPI (less for very large pages). */
export async function pictureFromPdfPage(src, index) {
  const page = await src.pdf.getPage(index + 1);
  const info = src.pages[index];
  const vp1 = page.getViewport({ scale: 1, rotation: info.rotate });
  let dpi = Math.min(PDF_DPI, (MAX_PX * 72) / Math.max(vp1.width, vp1.height, 1));
  dpi = Math.floor(dpi);
  const vp = page.getViewport({ scale: dpi / 72, rotation: info.rotate });
  const w = Math.max(1, Math.round(vp.width)), h = Math.max(1, Math.round(vp.height));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d", { alpha: false });
  await page.render({ canvasContext: g, canvas: c, viewport: vp, background: "#ffffff" }).promise;
  const blob = await blobOf(c, "image/png");
  c.width = 0;
  return { blob, type: "png", pw: w, ph: h, dpi };
}

/* ---------- the picture with its settings applied ---------- */

const bitmaps = new Map(); // hash -> Promise<ImageBitmap>, the last few
async function originalBitmap(doc, hash) {
  let p = bitmaps.get(hash);
  if (p) { bitmaps.delete(hash); bitmaps.set(hash, p); return p; }
  const pic = picsOf(doc).get(hash);
  if (!pic) throw new PictureError("The picture isn't loaded.");
  p = createImageBitmap(pic.blob);
  bitmaps.set(hash, p);
  p.catch(() => bitmaps.delete(hash));
  while (bitmaps.size > 3) {
    const [k, old] = bitmaps.entries().next().value;
    bitmaps.delete(k);
    // closed a little later: something may still be drawing it
    old.then((b) => setTimeout(() => { if (![...bitmaps.values()].includes(old)) b.close(); }, 15000)).catch(() => {});
  }
  return p;
}

const lum = (r, g, b) => (r * 19595 + g * 38470 + b * 7471 + 0x8000) >> 16;

/** How light the paper is in a scan or photo (grey levels): its most common light level, or 255 when little is light. */
function paperLevel(canvas) {
  const k = Math.min(1, 256 / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * k)), h = Math.max(1, Math.round(canvas.height * k));
  const small = canvasOf(w, h);
  const g = small.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(canvas, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const hist = new Array(256).fill(0);
  for (let i = 0; i < d.length; i += 4) hist[lum(d[i], d[i + 1], d[i + 2])]++;
  let light = 0;
  for (let v = 170; v < 256; v++) light += hist[v];
  if (light < (w * h) * 0.05) return 255;
  let best = 170, bestN = -1;
  for (let v = 170; v < 256; v++) {
    let n = 0;
    for (let u = Math.max(170, v - 2); u < Math.min(256, v + 3); u++) n += hist[u];
    if (n >= bestN) { bestN = n; best = v; }
  }
  return best;
}

/** Colour settings applied to a canvas (in place): grey, brightness, contrast, black and white, paper removed. */
function applyLook(canvas, s) {
  const w = canvas.width, h = canvas.height;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const n = d.length;
  if (s.look === "grey") {
    for (let i = 0; i < n; i += 4) { const L = lum(d[i], d[i + 1], d[i + 2]); d[i] = d[i + 1] = d[i + 2] = L; }
  }
  if (s.bright) {
    const f = 1 + s.bright / 100;
    for (let i = 0; i < n; i += 4) { d[i] *= f; d[i + 1] *= f; d[i + 2] *= f; }
  }
  if (s.contrast) {
    const f = Math.max(0, 1 + s.contrast / 100);
    let sum = 0;
    for (let i = 0; i < n; i += 4) sum += lum(d[i], d[i + 1], d[i + 2]);
    const mean = Math.floor(sum / (n / 4) + 0.5);
    for (let i = 0; i < n; i += 4) {
      d[i] = mean + (d[i] - mean) * f; d[i + 1] = mean + (d[i + 1] - mean) * f; d[i + 2] = mean + (d[i + 2] - mean) * f;
    }
  }
  if (s.look === "bw") { // after brightness and contrast, so they set how much turns black
    for (let i = 0; i < n; i += 4) { const v = lum(d[i], d[i + 1], d[i + 2]) >= 150 ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
  }
  if (s.white) {
    // the paper goes see-through (scans are rarely pure white), with a soft edge so lines stay smooth
    g.putImageData(img, 0, 0);
    const hi = Math.min(245, paperLevel(canvas) - 8), lo = hi - 30;
    for (let i = 0; i < n; i += 4) {
      const v = lum(d[i], d[i + 1], d[i + 2]);
      const clear = v >= hi ? 0 : v <= lo ? 255 : Math.floor(((hi - v) * 255) / 30);
      d[i + 3] = (d[i + 3] * clear) / 255;
    }
  }
  g.putImageData(img, 0, 0);
}

/** The shown part of the picture with its colour settings applied, as a canvas. maxPx > 0: a smaller copy. */
export async function processedCanvas(doc, s, maxPx = 0) {
  const bmp = await originalBitmap(doc, s.hash);
  const W = bmp.width, H = bmp.height;
  const [l, t, r, b] = s.crop;
  const x0 = Math.round(W * l), y0 = Math.round(H * t);
  const x1 = Math.max(x0 + 1, Math.round(W * (1 - r))), y1 = Math.max(y0 + 1, Math.round(H * (1 - b)));
  const cw = x1 - x0, ch = y1 - y0;
  const k = maxPx && Math.max(cw, ch) > maxPx ? maxPx / Math.max(cw, ch) : 1;
  const w = Math.max(1, Math.round(cw * k)), h = Math.max(1, Math.round(ch * k));
  const c = canvasOf(w, h);
  const g = c.getContext("2d", { willReadFrequently: changesPixels(s) });
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, x0, y0, cw, ch, 0, 0, w, h);
  if (changesPixels(s)) applyLook(c, s);
  return c;
}

const lookKey = (s) => `${s.hash}|${s.crop.map((v) => v.toFixed(4)).join(",")}|${s.look}|${s.white ? 1 : 0}|${s.bright}|${s.contrast}`;

/* ---------- on screen ---------- */

const screen = new Map(); // look key -> { url } | { pending: Promise }
const lastShown = new Map(); // picture id -> the copy last shown, kept on screen while a new one is made
function screenURL(doc, s, onReady) {
  const key = lookKey(s);
  const hit = screen.get(key);
  if (hit && hit.url) { screen.delete(key); screen.set(key, hit); return hit.url; }
  if (hit && hit.pending) { if (onReady) hit.waiting.add(onReady); return null; }
  const entry = { pending: null, waiting: new Set(onReady ? [onReady] : []) };
  entry.pending = (async () => {
    const c = await processedCanvas(doc, s, SCREEN_PX);
    const png = s.white || s.look === "bw";
    const blob = await blobOf(c, png ? "image/png" : "image/jpeg", 0.92);
    return URL.createObjectURL(blob);
  })();
  screen.set(key, entry);
  entry.pending.then((url) => {
    entry.url = url;
    entry.pending = null;
    for (const fn of entry.waiting) { try { fn(); } catch (e) { /* page gone */ } }
    entry.waiting.clear();
    const inUse = new Set(lastShown.values());
    for (const [k, old] of [...screen.entries()]) {
      if (screen.size <= 24) break;
      if (old.pending || inUse.has(old.url)) continue;
      screen.delete(k);
      URL.revokeObjectURL(old.url);
    }
  }).catch((e) => { console.warn("Picture couldn't be drawn", e); screen.delete(key); });
  return null;
}

function originalURL(doc, hash) {
  const pic = picsOf(doc).get(hash);
  if (!pic) return null;
  if (!pic.url) pic.url = URL.createObjectURL(pic.blob);
  return pic.url;
}

const n4 = (v) => String(Math.round(v * 10000) / 10000);
const mstr = (m) => `matrix(${m.map(n4).join(" ")})`;
const escA = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * SVG for a picture, in base units. onReady: called once a changed copy for the screen is ready
 * (until then a light box stands in). whole: the whole original, uncropped (cropping shows it faintly).
 */
export function picSVG(doc, it, { onReady = null, whole = false, opacity = null } = {}) {
  let s = settingsOf(it);
  if (!s.hash) return "";
  const w = it.w, h = it.h;
  const op = opacity != null ? opacity : it.opacity == null ? 1 : it.opacity;
  let place = [-w / 2, -h / 2, w, h];
  let clip = false;
  if (whole) {
    const [x0, y0, x1, y1] = fullBox(it);
    place = [x0, y0, x1 - x0, y1 - y0];
    s = { ...s, crop: [0, 0, 0, 0] };
  }
  let url;
  if (!changesPixels(s)) {
    url = originalURL(doc, s.hash);
    if (!whole) {
      const [x0, y0, x1, y1] = fullBox(it);
      place = [x0, y0, x1 - x0, y1 - y0];
      clip = s.crop.some((v) => v > 0);
    }
  } else {
    url = screenURL(doc, s, onReady);
    if (url && !whole) lastShown.set(it.id, url);
    else if (!url && !whole && lastShown.has(it.id)) url = lastShown.get(it.id);
  }
  const flip = s.flip[0] || s.flip[1] ? ` transform="scale(${s.flip[0] ? -1 : 1} ${s.flip[1] ? -1 : 1})"` : "";
  let body = url
    ? `<g${flip}><image href="${escA(url)}" x="${n4(place[0])}" y="${n4(place[1])}" width="${n4(place[2])}" height="${n4(place[3])}" preserveAspectRatio="none"/></g>`
    : `<rect x="${n4(-w / 2)}" y="${n4(-h / 2)}" width="${n4(w)}" height="${n4(h)}" fill="#e3e7ec"/>`;
  let defs = "";
  if (url && clip) {
    const id = `pc-${String(it.id).replace(/[^\w-]/g, "")}`;
    defs = `<clipPath id="${id}"><rect x="${n4(-w / 2)}" y="${n4(-h / 2)}" width="${n4(w)}" height="${n4(h)}"/></clipPath>`;
    body = `<g clip-path="url(#${id})">${body}</g>`;
  }
  if (s.border && it.width > 0 && !whole) {
    body += `<rect x="${n4(-w / 2)}" y="${n4(-h / 2)}" width="${n4(w)}" height="${n4(h)}" fill="none" stroke="${escA(it.color || "#1F2328")}" stroke-width="${n4(it.width)}" stroke-linejoin="miter"/>`;
  }
  return `<g transform="${mstr(frameOf(it))}"${op < 0.999 ? ` opacity="${n4(op)}"` : ""}>${defs}${body}</g>`;
}

/** Draws a picture onto a canvas whose transform maps base units to it (thumbnails). */
export async function drawPicOnCanvas(g, doc, it, maxPx = 640) {
  const s = settingsOf(it);
  if (!s.hash || !picsOf(doc).has(s.hash)) return;
  const c = await processedCanvas(doc, s, maxPx);
  g.save();
  const F = frameOf(it);
  g.transform(F[0], F[1], F[2], F[3], F[4], F[5]);
  g.globalAlpha = it.opacity == null ? 1 : it.opacity;
  g.save();
  g.scale(s.flip[0] ? -1 : 1, s.flip[1] ? -1 : 1);
  g.drawImage(c, -it.w / 2, -it.h / 2, it.w, it.h);
  g.restore();
  if (s.border && it.width > 0) {
    g.strokeStyle = it.color || "#1F2328";
    g.lineWidth = it.width;
    g.strokeRect(-it.w / 2, -it.h / 2, it.w, it.h);
  }
  g.restore();
}

/* ---------- in the PDF ---------- */

/** Bytes compressed for /FlateDecode. */
export async function deflate(bytes) {
  if (typeof CompressionStream !== "undefined") {
    const cs = new CompressionStream("deflate");
    const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
    return new Uint8Array(await out.arrayBuffer());
  }
  return window.PDFLib && window.PDFLib.pako ? window.PDFLib.pako.deflate(bytes) : bytes;
}

/** Pixels of a canvas for a PDF image: { w, h, gray, color (Uint8Array), alpha (Uint8Array | null) }. */
export function canvasPixels(c, gray = false) {
  const w = c.width, h = c.height;
  const d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const n = w * h;
  const color = new Uint8Array(n * (gray ? 1 : 3));
  let alpha = null;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    if (gray) color[i] = d[j];
    else { color[i * 3] = d[j]; color[i * 3 + 1] = d[j + 1]; color[i * 3 + 2] = d[j + 2]; }
    if (d[j + 3] < 255 && !alpha) { alpha = new Uint8Array(n).fill(255); }
    if (alpha) alpha[i] = d[j + 3];
  }
  return { w, h, gray, color, alpha };
}

/** The original picture, as a PDF image needs it: { jpeg, info } or pixels (see canvasPixels). */
export async function originalForPdf(doc, hash) {
  const pic = picsOf(doc).get(hash);
  if (!pic) throw new PictureError("The picture isn't loaded.");
  const bytes = new Uint8Array(await pic.blob.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const info = jpegInfo(bytes);
    if (info.w && info.h) return { jpeg: bytes, info };
  }
  const bmp = await originalBitmap(doc, hash);
  const c = canvasOf(bmp.width, bmp.height);
  c.getContext("2d").drawImage(bmp, 0, 0);
  return canvasPixels(c);
}

/** The picture with its colour settings and crop applied, for the PDF: { jpeg } or pixels. */
export async function processedForPdf(doc, s) {
  const c = await processedCanvas(doc, s, 0);
  const pic = picsOf(doc).get(s.hash);
  const gray = s.look === "grey" || s.look === "bw";
  if (!s.white && s.look !== "bw" && pic && pic.type === "jpeg") {
    const blob = await blobOf(c, "image/jpeg", 0.9);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { jpeg: bytes, info: jpegInfo(bytes) };
  }
  return canvasPixels(c, gray);
}

/* ---------- reading a picture back from a PDF ---------- */

function names(v) {
  const L = window.PDFLib;
  if (!v) return [];
  if (v instanceof L.PDFName) return [v.asString().replace(/^\//, "")];
  if (v instanceof L.PDFArray) return v.asArray().map((x) => (x instanceof L.PDFName ? x.asString().replace(/^\//, "") : ""));
  return [""];
}

function unpredict(data, parms, w, comps) {
  const L = window.PDFLib;
  if (!(parms instanceof L.PDFDict)) return data;
  const pr = parms.lookupMaybe(L.PDFName.of("Predictor"), L.PDFNumber);
  const p = pr ? pr.asNumber() : 1;
  if (p < 10) return data;
  const bpp = comps;
  const row = w * comps;
  const rows = Math.floor(data.length / (row + 1));
  const out = new Uint8Array(rows * row);
  for (let y = 0; y < rows; y++) {
    const f = data[y * (row + 1)];
    const src = y * (row + 1) + 1, dst = y * row, prev = dst - row;
    for (let x = 0; x < row; x++) {
      const raw = data[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let v = raw;
      if (f === 1) v = raw + a;
      else if (f === 2) v = raw + b;
      else if (f === 3) v = raw + ((a + b) >> 1);
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[dst + x] = v & 255;
    }
  }
  return out;
}

function decodedPixels(ctx, stream) {
  const L = window.PDFLib;
  const { PDFName, PDFNumber, PDFArray } = L;
  const dict = stream.dict;
  const w = dict.lookup(PDFName.of("Width"), PDFNumber).asNumber();
  const h = dict.lookup(PDFName.of("Height"), PDFNumber).asNumber();
  const bpcN = dict.lookupMaybe(PDFName.of("BitsPerComponent"), PDFNumber);
  if (bpcN && bpcN.asNumber() !== 8) throw new Error("bits");
  let cs = dict.lookup(PDFName.of("ColorSpace"));
  let comps = 3;
  const csName = names(cs instanceof PDFArray ? cs.get(0) : cs)[0];
  if (csName === "DeviceGray" || csName === "CalGray") comps = 1;
  else if (csName === "DeviceRGB" || csName === "CalRGB") comps = 3;
  else if (csName === "DeviceCMYK") comps = 4;
  else if (csName === "ICCBased") {
    const icc = ctx.lookup(cs.get(1));
    const nn = icc && icc.dict && icc.dict.lookupMaybe(PDFName.of("N"), PDFNumber);
    comps = nn ? nn.asNumber() : 3;
  } else if (!cs) comps = 1; // a soft mask
  else throw new Error("colour space");
  const filters = names(dict.get(PDFName.of("Filter")));
  let data = filters.length ? L.decodePDFRawStream(stream).decode() : stream.getContents();
  const parms = dict.lookupMaybe(PDFName.of("DecodeParms"), L.PDFDict) || (dict.lookup(PDFName.of("DecodeParms")) instanceof PDFArray ? dict.lookup(PDFName.of("DecodeParms")).lookup(0) : null);
  data = unpredict(data, parms, w, comps);
  if (data.length < w * h * comps) throw new Error("short");
  return { w, h, comps, data };
}

/**
 * The original picture an annotation points at (/TPTImg), as { blob, type, pw, ph }, or null when
 * the phone can't read it (the picture then stays in the PDF as it is).
 */
export async function pictureFromPdfImage(ctx, ref) {
  const L = window.PDFLib;
  const { PDFName } = L;
  const stream = ctx.lookup(ref);
  if (!stream || !stream.dict) return null;
  const dict = stream.dict;
  const filters = names(dict.get(PDFName.of("Filter")));
  const smaskRef = dict.get(PDFName.of("SMask"));
  const isJpeg = filters.length === 1 && filters[0] === "DCTDecode";
  if (isJpeg && !smaskRef) {
    const bytes = stream.getContents();
    const info = jpegInfo(bytes);
    if (info.comps === 4) {
      // CMYK: drawn by the browser into RGB first
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const c = canvasOf(bmp.width, bmp.height);
      c.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close();
      return { blob: await blobOf(c, "image/jpeg", 0.92), type: "jpeg", pw: c.width, ph: c.height };
    }
    return { blob: new Blob([bytes.slice()], { type: "image/jpeg" }), type: "jpeg", pw: info.w, ph: info.h };
  }
  let w, h, rgba;
  if (isJpeg) {
    const bmp = await createImageBitmap(new Blob([stream.getContents()], { type: "image/jpeg" }));
    w = bmp.width; h = bmp.height;
    const c = canvasOf(w, h);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    bmp.close();
    rgba = g.getImageData(0, 0, w, h);
  } else {
    if (filters.some((f) => f !== "FlateDecode")) return null;
    const px = decodedPixels(ctx, stream);
    w = px.w; h = px.h;
    rgba = new ImageData(w, h);
    const d = rgba.data, s = px.data, n = w * h;
    for (let i = 0; i < n; i++) {
      const j = i * px.comps, k = i * 4;
      if (px.comps === 1) d[k] = d[k + 1] = d[k + 2] = s[j];
      else if (px.comps === 4) {
        const K = 255 - s[j + 3];
        d[k] = ((255 - s[j]) * K) / 255; d[k + 1] = ((255 - s[j + 1]) * K) / 255; d[k + 2] = ((255 - s[j + 2]) * K) / 255;
      } else { d[k] = s[j]; d[k + 1] = s[j + 1]; d[k + 2] = s[j + 2]; }
      d[k + 3] = 255;
    }
  }
  if (smaskRef) {
    const ms = ctx.lookup(smaskRef);
    const mf = names(ms.dict.get(PDFName.of("Filter")));
    if (mf.some((f) => f !== "FlateDecode")) return null;
    const m = decodedPixels(ctx, ms);
    if (m.w !== w || m.h !== h) return null;
    for (let i = 0; i < w * h; i++) rgba.data[i * 4 + 3] = m.data[i];
  }
  const c = canvasOf(w, h);
  c.getContext("2d").putImageData(rgba, 0, 0);
  return { blob: await blobOf(c, "image/png"), type: "png", pw: w, ph: h };
}

export { mstr };
