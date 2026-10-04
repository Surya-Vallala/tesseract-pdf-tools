// Building the finished PDF and handing it over (Share or Download).
import { libDoc, baseName, FULL, imagePageSize } from "./doc.js";
import { cropUserRect } from "./render.js";
import { layersEdited } from "./layers.js";
import { openSheet, h, esc, icon, busy, toast } from "./ui.js";

const IMAGE_MAX = 4096;

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
    if (!kids) return; // a page, not a tree node
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

/**
 * Make a new PDF from the given pages (in order).
 * keepLayers: write the current layer on/off state as the file's default.
 */
export async function buildPdf(doc, pages, { keepLayers = false, title = "" } = {}) {
  const L = window.PDFLib;
  const { PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFNull, PDFObjectCopier, PDFPage, PDFHexString, degrees } = L;
  const out = await PDFDocument.create({ updateMetadata: false });
  const ctx = out.context;
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
    // Point links to dropped pages (and the old page tree) at nothing, so they aren't dragged along.
    const tm = st.copier.traversedObjects;
    for (const r of pageTreeRefs(st.lib)) tm.set(r, PDFNull);
    st.srcPages.forEach((pg, i) => tm.set(pg.ref, st.newRefs.get(i) || PDFNull));
  }

  const photoCache = new Map();
  for (const p of pages) {
    const s = doc.src(p);
    const st = states.get(s.id);
    if (s.kind === "pdf") {
      const leaf = st.copier.copy(st.srcPages[p.index].node);
      let ref = st.newRefs.get(p.index);
      if (st.placed.has(p.index)) ref = ctx.nextRef();
      st.placed.add(p.index);
      ctx.assign(ref, leaf);
      const info = s.pages[p.index];
      const rot = (((info.rotate + p.rot) % 360) + 360) % 360;
      leaf.set(PDFName.of("Rotate"), PDFNumber.of(rot));
      if (p.crop) leaf.set(PDFName.of("CropBox"), ctx.obj(cropUserRect(info.view, p.crop)));
      out.addPage(PDFPage.of(leaf, ref, out));
      if (!st.firstRef) st.firstRef = ref;
    } else {
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
      const page = out.addPage([pw, ph]);
      page.drawImage(img, { x: (pw - uw * k) / 2, y: (ph - uh * k) / 2, width: uw * k, height: uh * k });
      if (R) page.setRotation(degrees(R));
      if (!st.firstRef) st.firstRef = page.ref;
    }
  }

  const pdfSources = used.filter((s) => s.kind === "pdf");
  const single = used.length === 1 && pdfSources.length === 1;

  /* Layers */
  const layered = pdfSources.filter((s) => s.oc);
  if (layered.length) {
    const ocgs = [], on = [], off = [], order = [], rb = [], locked = [], autoState = [];
    let singleProps = null;
    for (const s of layered) {
      const st = states.get(s.id);
      const props = st.lib.catalog.lookupMaybe(PDFName.of("OCProperties"), PDFDict);
      if (!props) continue;
      const copied = st.copier.copy(props);
      const list = copied.lookupMaybe(PDFName.of("OCGs"), PDFArray);
      if (list) ocgs.push(...list.asArray());
      const cfg = keepLayers ? s.oc : await s.pdf.getOptionalContentConfig();
      for (const [id, g] of cfg) {
        const src = refFromId(id);
        const mapped = src && st.copier.traversedObjects.get(src);
        if (mapped && mapped !== PDFNull) (g.visible ? on : off).push(mapped);
      }
      const D = copied.lookupMaybe(PDFName.of("D"), PDFDict);
      const ord = D && D.lookupMaybe(PDFName.of("Order"), PDFArray);
      if (ord) {
        if (layered.length > 1) order.push(ctx.obj([PDFHexString.fromText(baseName(s.name)), ...ord.asArray()]));
        else order.push(...ord.asArray());
      }
      const rbg = D && D.lookupMaybe(PDFName.of("RBGroups"), PDFArray);
      if (rbg) rb.push(...rbg.asArray());
      const lk = D && D.lookupMaybe(PDFName.of("Locked"), PDFArray);
      if (lk) locked.push(...lk.asArray());
      const as = D && D.lookupMaybe(PDFName.of("AS"), PDFArray);
      if (as) {
        for (const item of as.asArray()) {
          const d = ctx.lookup(item);
          const ev = d instanceof PDFDict ? d.get(PDFName.of("Event")) : null;
          // With the user's own choice saved, don't let "on view" rules override it.
          if (keepLayers && ev && ev.toString() === "/View") continue;
          autoState.push(item);
        }
      }
      if (layered.length === 1) singleProps = { copied, D };
    }
    if (ocgs.length) {
      const fields = { BaseState: "ON", ON: on, OFF: off };
      if (order.length) fields.Order = order;
      if (rb.length) fields.RBGroups = rb;
      if (locked.length) fields.Locked = locked;
      if (autoState.length) fields.AS = autoState;
      if (singleProps && singleProps.D) {
        const D = singleProps.D;
        for (const k of ["BaseState", "ON", "OFF", "AS"]) D.delete(PDFName.of(k));
        for (const [k, v] of Object.entries(fields)) if (k !== "Order" && k !== "RBGroups" && k !== "Locked") D.set(PDFName.of(k), ctx.obj(v));
        out.catalog.set(PDFName.of("OCProperties"), singleProps.copied);
      } else {
        out.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: ocgs, D: ctx.obj(fields) }));
      }
    }
  }

  /* Bookmarks and other document-level parts */
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
    for (const key of ["PageMode", "PageLayout"]) {
      const v = cat.get(PDFName.of(key));
      if (v instanceof PDFName) out.catalog.set(PDFName.of(key), v);
    }
  } else if (used.length > 1) {
    const marks = used.filter((s) => states.get(s.id).firstRef);
    const rootRef = ctx.nextRef();
    const refs = marks.map(() => ctx.nextRef());
    marks.forEach((s, i) => {
      const item = {
        Title: PDFHexString.fromText(baseName(s.name)),
        Parent: rootRef,
        Dest: [states.get(s.id).firstRef, "Fit"]
      };
      if (i > 0) item.Prev = refs[i - 1];
      if (i < refs.length - 1) item.Next = refs[i + 1];
      ctx.assign(refs[i], ctx.obj(item));
    });
    ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: refs[0], Last: refs[refs.length - 1], Count: refs.length }));
    out.catalog.set(PDFName.of("Outlines"), rootRef);
  }

  if (title) out.setTitle(title);
  out.setProducer("Tesseract PDF Tools");
  out.setCreator("Tesseract PDF Tools (phone)");
  const now = new Date();
  out.setCreationDate(now);
  out.setModificationDate(now);
  return out.save({ useObjectStreams: true });
}

/* ---------- Save sheet ---------- */

function canShareFiles() {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File([new Uint8Array(1)], "x.pdf", { type: "application/pdf" })] }));
  } catch (e) {
    return false;
  }
}

function cleanName(n) {
  return n.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().replace(/\.pdf$/i, "") || "Document";
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
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

export function openSaveSheet(doc, { pages = null, onSaved } = {}) {
  const extract = !!pages;
  const list = pages || doc.pages;
  const readOnly = doc.readOnly;
  const share = canShareFiles();
  const edited = layersEdited(doc) && list.some((p) => doc.src(p).oc);
  const hasPhotos = list.some((p) => doc.src(p).kind === "image");
  const defaultName = extract ? `${doc.name} - ${pageRangeLabel(doc, list)}` : doc.name;

  const body = h(`<div>
    ${readOnly ? `<p class="warn">This PDF is password-protected. You can share or download it as it is. Saving changes to protected PDFs comes in a later update.</p>` : ""}
    <label class="field"><span>File name</span>
      <span class="namefield"><input class="input" name="fname" value="${esc(defaultName)}" autocomplete="off" spellcheck="false" enterkeyhint="done"><em>.pdf</em></span>
    </label>
    ${!readOnly && edited ? `<label class="check-row"><input type="checkbox" name="keep" checked>
      <span>Keep my layer changes<small>Layers you turned off stay off when the PDF is opened anywhere.</small></span></label>` : ""}
    ${!readOnly && hasPhotos ? `<div class="field"><span>Photo page size</span>
      <div class="seg" data-fit>
        <button type="button" data-v="a4">A4</button><button type="button" data-v="a3">A3</button><button type="button" data-v="fit">Fit photo</button>
      </div></div>` : ""}
    <p class="note">${list.length} page${list.length === 1 ? "" : "s"}${extract ? " selected" : ""}.</p>
  </div>`);
  const foot = h(`<div style="display:flex;gap:10px;flex:1">
    ${share ? `<button class="btn primary" type="button" data-go="share">${""}Share</button>` : ""}
    <button class="btn ${share ? "" : "primary"}" type="button" data-go="download">Download</button>
  </div>`);
  foot.querySelectorAll(".btn").forEach((b) => { b.style.flex = "1"; });
  const sheet = openSheet({ title: extract ? "Extract pages" : "Save PDF", body, foot });

  const seg = body.querySelector("[data-fit]");
  if (seg) {
    const paint = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === doc.imageFit));
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b || b.dataset.v === doc.imageFit) return;
      doc.commit();
      doc.imageFit = b.dataset.v;
      doc.changed({ fit: true });
      paint();
    });
    paint();
  }

  let ready = null; // a finished file waiting for a second tap (share needs a fresh tap after a long build)
  const forget = () => {
    ready = null;
    const sb = foot.querySelector('[data-go="share"]');
    if (sb) sb.textContent = "Share";
  };
  body.addEventListener("input", forget);
  body.addEventListener("change", forget);
  body.addEventListener("click", (e) => { if (e.target.closest("[data-fit]")) forget(); });

  async function make() {
    const name = cleanName(body.querySelector("[name=fname]").value) + ".pdf";
    if (ready && ready.name === name) return ready;
    if (readOnly) {
      const s = doc.src(list[0]);
      ready = new File([s.bytes], name, { type: "application/pdf" });
      return ready;
    }
    const keep = body.querySelector("[name=keep]");
    const b = busy(extract ? "Extracting pages…" : "Making your PDF…");
    try {
      const bytes = await buildPdf(doc, list, { keepLayers: keep ? keep.checked : false, title: name.replace(/\.pdf$/i, "") });
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
      const msg = /encrypt/i.test(String(err && err.message)) ? "This PDF is password-protected, so it can't be changed yet." : "The PDF couldn't be made. Try again, or try with fewer pages.";
      toast(msg, { ms: 5000 });
      return;
    }
    if (btn.dataset.go === "download") {
      download(file);
      if (!extract) doc.dirty = false;
      sheet.close();
      toast(`Saved to Downloads as ${file.name}`);
      onSaved && onSaved();
      return;
    }
    try {
      await navigator.share({ files: [file], title: file.name });
      if (!extract) doc.dirty = false;
      sheet.close();
      onSaved && onSaved();
    } catch (err) {
      if (err && err.name === "AbortError") return; // closed the share menu
      if (err && err.name === "NotAllowedError") {
        btn.textContent = "Share now";
        toast("Your PDF is ready. Tap Share now.");
        return;
      }
      toast("Sharing didn't work. Use Download instead.");
    }
  });
  return sheet;
}
