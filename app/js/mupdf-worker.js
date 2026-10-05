// Heavy PDF jobs, run off the main thread with MuPDF:
// unlocking protected PDFs, permanent blur, passwords, reducing size, pulling out images.
import * as mupdf from "../vendor/mupdf/mupdf.js";

mupdf.setLog(null);

function progress(id, text) {
  self.postMessage({ id, progress: text });
}

function openPdf(bytes, password) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  if (doc.needsPassword()) {
    if (!doc.authenticatePassword(password || "")) {
      doc.destroy();
      throw new Error("password");
    }
  }
  return doc.asPDF();
}

function saveOptions(password) {
  const opts = ["garbage=compact", "compress"];
  if (password) {
    opts.push("encrypt=aes-256", "user-password=" + password, "owner-password=" + password, "permissions=-1");
  } else {
    opts.push("encrypt=none");
  }
  return opts.join(",");
}

function out(buf) {
  const u8 = buf.asUint8Array();
  const copy = new Uint8Array(u8.length);
  copy.set(u8);
  buf.destroy();
  return copy;
}

const OPS = {
  async unlock(id, bytes, password) {
    const doc = openPdf(bytes, password);
    const result = out(doc.saveToBuffer("encrypt=none"));
    doc.destroy();
    return result;
  },

  /**
   * Final step of saving: permanent blur, then the password.
   * blurs: [{ page, rect: [x0, y0, x1, y1] in PDF user space }]
   */
  async finalize(id, bytes, { blurs = [], overlays = [], password = null } = {}) {
    const doc = new mupdf.PDFDocument(bytes);
    const byPage = new Map();
    for (const b of blurs) {
      if (!byPage.has(b.page)) byPage.set(b.page, []);
      byPage.get(b.page).push(b.rect);
    }
    const overlayFor = new Map(overlays.map((o) => [o.page, o.num]));
    let n = 0;
    for (const [pageIndex, rects] of byPage) {
      progress(id, `Blurring page ${pageIndex + 1}…`);
      const page = doc.loadPage(pageIndex);
      const ctm = page.getTransform();
      const patches = [];
      for (const r of rects) {
        const fz = mupdf.Rect.transform(r, ctm);
        const wpt = fz[2] - fz[0], hpt = fz[3] - fz[1];
        if (wpt < 1 || hpt < 1) continue;
        const s = Math.max(0.5, Math.min(3, 1400 / Math.max(wpt, hpt)));
        const bb = [Math.floor(fz[0] * s), Math.floor(fz[1] * s), Math.ceil(fz[2] * s), Math.ceil(fz[3] * s)];
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bb, false);
        pix.clear(255);
        const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
        page.run(dev, mupdf.Matrix.scale(s, s));
        dev.close();
        dev.destroy();
        const png = await blurPixmap(pix);
        pix.destroy();
        patches.push({ r, png });
        const annot = page.createAnnotation("Redact");
        annot.setRect(fz);
        annot.update();
      }
      page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      const pobj = page.getObject();
      let res = pobj.get("Resources");
      if (res.isNull()) {
        const inherited = pobj.getInheritable("Resources");
        res = doc.newDictionary();
        if (!inherited.isNull()) inherited.forEach((v, k) => res.put(k, v));
        pobj.put("Resources", res);
      }
      let xo = res.get("XObject");
      if (xo.isNull()) {
        xo = doc.newDictionary();
        res.put("XObject", xo);
      }
      let ops = "";
      for (const p of patches) {
        const name = `TPTBlur${++n}`;
        const img = new mupdf.Image(p.png);
        xo.put(name, doc.addImage(img));
        img.destroy();
        const [x0, y0, x1, y1] = p.r;
        ops += `q ${x1 - x0} 0 0 ${y1 - y0} ${x0} ${y0} cm /${name} Do Q\n`;
      }
      if (overlayFor.has(pageIndex)) {
        xo.put("TPTWm", doc.newIndirect(overlayFor.get(pageIndex)));
        ops += "/TPTWm Do\n";
      }
      const stream = doc.addStream("\nq\n" + ops + "Q\n", {});
      const contents = pobj.get("Contents");
      const arr = doc.newArray();
      if (contents.isArray()) contents.forEach((v) => arr.push(v));
      else if (!contents.isNull()) arr.push(contents);
      arr.push(stream);
      pobj.put("Contents", arr);
      page.destroy();
    }
    progress(id, password ? "Adding the password…" : "Finishing…");
    const result = out(doc.saveToBuffer(saveOptions(password)));
    doc.destroy();
    return result;
  },

  // Re-save photos and scans at a lower resolution. dpi: target, quality: JPEG 0..1.
  async reduce(id, bytes, { dpi = 150, quality = 0.72, pageInches = 11.7, password = null } = {}) {
    const doc = new mupdf.PDFDocument(bytes);
    const maxPx = Math.round(pageInches * dpi);
    const count = doc.countObjects();
    const smasks = new Set();
    for (let i = 1; i < count; i++) {
      try {
        const o = doc.newIndirect(i).resolve();
        if (o.isDictionary()) {
          const sm = o.get("SMask");
          if (sm.isIndirect()) smasks.add(sm.asIndirect());
        }
      } catch (e) { /* skip */ }
    }
    let done = 0, changed = 0;
    for (let i = 1; i < count; i++) {
      let ref;
      try { ref = doc.newIndirect(i); } catch (e) { continue; }
      let obj;
      try { obj = ref.resolve(); } catch (e) { continue; }
      if (!obj.isStream()) continue;
      if (String(obj.get("Subtype")) !== "/Image") continue;
      if (String(obj.get("ImageMask")) === "true") continue;
      const w = obj.get("Width").asNumber(), h = obj.get("Height").asNumber();
      const bpc = obj.get("BitsPerComponent").isNull() ? 8 : obj.get("BitsPerComponent").asNumber();
      if (bpc < 8 || Math.max(w, h) <= maxPx * 1.15 || w * h < 40000 || smasks.has(i)) continue;
      done++;
      if (done % 3 === 1) progress(id, `Shrinking image ${done}…`);
      try {
        const oldLen = obj.readRawStream().getLength();
        const image = doc.loadImage(ref);
        let pix = image.toPixmap();
        const cs = pix.getColorSpace();
        if (!cs || !(cs.isRGB() || cs.isGray())) {
          const conv = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
          pix.destroy();
          pix = conv;
        }
        const k = maxPx / Math.max(w, h);
        const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
        const jpeg = await shrink(pix, nw, nh, quality);
        pix.destroy();
        image.destroy();
        if (!jpeg || jpeg.length > oldLen * 0.9) continue;
        obj.writeRawStream(jpeg);
        obj.put("Filter", doc.newName("DCTDecode"));
        obj.put("Width", nw);
        obj.put("Height", nh);
        obj.put("BitsPerComponent", 8);
        obj.put("ColorSpace", doc.newName("DeviceRGB"));
        obj.delete("DecodeParms");
        obj.delete("Decode");
        if (obj.get("Mask").isArray()) obj.delete("Mask");
        changed++;
      } catch (e) {
        // leave this image as it was
      }
    }
    progress(id, "Finishing…");
    const result = out(doc.saveToBuffer(saveOptions(password)));
    doc.destroy();
    return { bytes: result, changed };
  },

  // The pictures inside the PDF, as JPEG or PNG files.
  async images(id, bytes) {
    const doc = new mupdf.PDFDocument(bytes);
    const count = doc.countObjects();
    const smasks = new Set();
    for (let i = 1; i < count; i++) {
      try {
        const o = doc.newIndirect(i).resolve();
        if (o.isDictionary()) {
          const sm = o.get("SMask");
          if (sm.isIndirect()) smasks.add(sm.asIndirect());
        }
      } catch (e) { /* skip */ }
    }
    const files = [];
    for (let i = 1; i < count; i++) {
      let ref, obj;
      try { ref = doc.newIndirect(i); obj = ref.resolve(); } catch (e) { continue; }
      if (!obj.isStream() || String(obj.get("Subtype")) !== "/Image" || smasks.has(i)) continue;
      if (String(obj.get("ImageMask")) === "true") continue;
      const w = obj.get("Width").asNumber(), h = obj.get("Height").asNumber();
      if (w < 48 || h < 48) continue;
      const n = files.length + 1;
      if (n % 3 === 1) progress(id, `Saving image ${n}…`);
      try {
        const filter = String(obj.get("Filter"));
        const csName = String(obj.get("ColorSpace"));
        if (filter === "/DCTDecode" && (csName === "/DeviceRGB" || csName === "/DeviceGray") && obj.get("SMask").isNull()) {
          const raw = obj.readRawStream();
          files.push({ name: `image-${String(n).padStart(3, "0")}.jpg`, type: "image/jpeg", bytes: out(raw) });
          continue;
        }
        const image = doc.loadImage(ref);
        let pix = image.toPixmap();
        const cs = pix.getColorSpace();
        if (cs && !cs.isRGB() && !cs.isGray()) {
          const conv = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
          pix.destroy();
          pix = conv;
        }
        const png = pix.asPNG();
        const copy = new Uint8Array(png.length);
        copy.set(png);
        files.push({ name: `image-${String(n).padStart(3, "0")}.png`, type: "image/png", bytes: copy });
        pix.destroy();
        image.destroy();
      } catch (e) {
        // skip images that can't be read
      }
    }
    doc.destroy();
    return files;
  }
};

function toImageData(pix) {
  const w = pix.getWidth(), h = pix.getHeight(), n = pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0);
  const src = pix.getPixels();
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += n) {
    if (n >= 3) {
      data[i * 4] = src[j]; data[i * 4 + 1] = src[j + 1]; data[i * 4 + 2] = src[j + 2];
    } else {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = src[j];
    }
    data[i * 4 + 3] = 255;
  }
  return new ImageData(data, w, h);
}

async function blurPixmap(pix) {
  const id = toImageData(pix);
  const w = id.width, h = id.height;
  // Pixelate, then blur: the original detail can't be recovered from the result.
  const small = Math.max(4, Math.round(Math.max(w, h) / 28));
  const sw = Math.max(2, Math.round((w / Math.max(w, h)) * small));
  const sh = Math.max(2, Math.round((h / Math.max(w, h)) * small));
  const bmp = await createImageBitmap(id, { resizeWidth: sw, resizeHeight: sh, resizeQuality: "medium" });
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  g.filter = `blur(${Math.max(2, Math.round(Math.max(w, h) / 60))}px)`;
  g.imageSmoothingEnabled = true;
  g.drawImage(bmp, -2, -2, w + 4, h + 4);
  bmp.close();
  const blob = await c.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

async function shrink(pix, nw, nh, quality) {
  const id = toImageData(pix);
  const bmp = await createImageBitmap(id, { resizeWidth: nw, resizeHeight: nh, resizeQuality: "high" });
  const c = new OffscreenCanvas(nw, nh);
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await c.convertToBlob({ type: "image/jpeg", quality });
  return new Uint8Array(await blob.arrayBuffer());
}

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const result = await OPS[op](id, ...args);
    const transfer = [];
    if (result instanceof Uint8Array) transfer.push(result.buffer);
    else if (result && result.bytes instanceof Uint8Array) transfer.push(result.bytes.buffer);
    else if (Array.isArray(result)) result.forEach((f) => f.bytes && transfer.push(f.bytes.buffer));
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
self.postMessage({ ready: true });
