// The Tools tab: password, watermark, reduce size, split, recognise text, save text, save images.
import { h, esc, icon, openSheet, segmented, toast, busy, confirmDialog, openMenu } from "./ui.js";
import { pickFiles } from "./platform.js";
import { engine, preloadEngine } from "./engine.js";
import { buildPdf, exportPdf, openResultSheet, formatSize } from "./save.js";
import { baseName } from "./doc.js";
import { pageGeom } from "./geom.js";
import { drawPage } from "./render.js";
import { wmSVG } from "./watermark.js";
import { LANGS, langReady, downloadLang, recognize, documentText } from "./ocr.js";


const TOOLS = [
  { id: "password", icon: "lock", title: "Password", text: "Add, change or remove a password" },
  { id: "watermark", icon: "watermark", title: "Watermark", text: "Text or a logo across the pages" },
  { id: "reduce", icon: "compress", title: "Reduce file size", text: "Smaller files for WhatsApp and email" },
  { id: "split", icon: "split", title: "Split into files", text: "By page ranges, or every page" },
  { id: "ocr", icon: "ocr", title: "Recognise text (OCR)", text: "Make scanned pages searchable and copyable" },
  { id: "text", icon: "textfile", title: "Save text", text: "All the text in a .txt file" },
  { id: "images", icon: "image", title: "Save images", text: "The pictures inside this PDF" }
];

export function openTools(ctx) {
  const body = h(`<div class="tools-body"></div>`);
  let sheet;
  for (const t of TOOLS) {
    const b = h(`<button type="button" class="tool-row"><span class="tool-ic">${icon(t.icon)}</span><span class="tool-text"><b>${esc(t.title)}</b><small>${esc(t.text)}</small></span>${icon("chev")}</button>`);
    b.addEventListener("click", () => {
      sheet.close();
      setTimeout(() => runTool(t.id, ctx), 30);
    });
    body.appendChild(b);
  }
  body.appendChild(h(`<p class="note tools-foot">Full screen: tap the page once. Tap again to bring the bars back.</p>`));
  sheet = openSheet({ title: "Tools", body });
  sheet.body.style.padding = "6px 0 12px";
}

function runTool(id, ctx) {
  const doc = ctx.doc();
  if (!doc) return;
  if (doc.readOnly && id !== "text") {
    toast("This PDF is password-protected and couldn't be unlocked here. Connect to the internet once, then open it again.", { ms: 6000 });
    return;
  }
  ({ password: openPassword, watermark: openWatermark, reduce: openReduce, split: openSplit, ocr: openOcr, text: saveText, images: saveImages })[id](ctx);
}

/* ---------- Password ---------- */

function openPassword(ctx) {
  const doc = ctx.doc();
  preloadEngine();
  if (doc.password) {
    const body = h(`<div><p class="note" style="margin-top:0">Saved copies of this PDF need its password to open.</p></div>`);
    const foot = h(`<div class="foot-row"><button class="btn danger-outline" type="button" data-a="remove">Remove password</button><button class="btn primary" type="button" data-a="change">Change password</button></div>`);
    const sheet = openSheet({ title: "Password", body, foot });
    foot.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-a]");
      if (!b) return;
      sheet.close();
      if (b.dataset.a === "change") setTimeout(() => passwordForm(ctx), 30);
      else {
        const ok = await confirmDialog({ title: "Remove the password?", message: "Saved copies will open without a password.", okText: "Remove", danger: true });
        if (!ok) return;
        doc.commit();
        doc.password = null;
        ctx.changed();
        toast("Password removed. Save to keep the change.");
      }
    });
    return;
  }
  passwordForm(ctx);
}

function passwordForm(ctx) {
  const doc = ctx.doc();
  const body = h(`<form autocomplete="off">
    <p class="note" style="margin-top:0">Anyone opening this PDF will need the password.</p>
    <label class="field"><span>Password</span><span class="pw-wrap"><input class="input" type="password" name="a" autocomplete="new-password"><button type="button" class="ib" aria-label="Show password">${icon("eye")}</button></span></label>
    <label class="field"><span>Type it again</span><input class="input" type="password" name="b" autocomplete="new-password"></label>
    <p class="form-error" hidden></p>
    <p class="note">Keep it somewhere safe. A forgotten password can't be recovered.</p>
  </form>`);
  const foot = h(`<div class="foot-row"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="button" data-ok>Protect PDF</button></div>`);
  const sheet = openSheet({ title: "Protect with a password", body, foot });
  const a = body.querySelector("[name=a]"), b2 = body.querySelector("[name=b]");
  const err = body.querySelector(".form-error");
  const eye = body.querySelector(".pw-wrap .ib");
  eye.addEventListener("click", () => {
    const show = a.type === "password";
    a.type = b2.type = show ? "text" : "password";
    eye.innerHTML = icon(show ? "eyeoff" : "eye");
    eye.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
  const submit = () => {
    const pw = a.value;
    let problem = null;
    if (!pw) problem = "Type a password.";
    else if (pw !== b2.value) problem = "The two passwords don't match.";
    else if (pw.includes(",")) problem = "Passwords can't contain commas.";
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    doc.commit();
    doc.password = pw;
    ctx.changed();
    sheet.close();
    toast("Done. Save the PDF to apply the password.");
  };
  foot.querySelector("[data-ok]").addEventListener("click", submit);
  body.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  foot.querySelector("[data-cancel]").addEventListener("click", () => sheet.close());
  setTimeout(() => a.focus(), 80);
}

/* ---------- Watermark ---------- */

// The Tesseract Design | Build logo: black for light pages, white for dark ones.
const LOGO_NAMES = { black: "Tesseract logo", white: "Tesseract logo, white" };
async function logoImage(variant = "black") {
  const res = await fetch(new URL(`../icons/tesseract-logo-${variant}.png`, import.meta.url));
  if (!res.ok) throw new Error("logo");
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const out = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png", w: bmp.width, h: bmp.height, url: URL.createObjectURL(blob), name: LOGO_NAMES[variant] || LOGO_NAMES.black, dark: variant === "white" };
  bmp.close();
  return out;
}

async function pictureImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  let bytes, mime;
  const isJpeg = file.type === "image/jpeg";
  if ((isJpeg || file.type === "image/png") && Math.max(bmp.width, bmp.height) <= 3000) {
    bytes = new Uint8Array(await file.arrayBuffer());
    mime = file.type;
  } else {
    const k = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await c.convertToBlob({ type: "image/png" });
    bytes = new Uint8Array(await blob.arrayBuffer());
    mime = "image/png";
  }
  const out = { bytes, mime, w: bmp.width, h: bmp.height, url: URL.createObjectURL(new Blob([bytes], { type: mime })), name: file.name };
  bmp.close();
  return out;
}

function parseRange(text, total) {
  const set = new Set();
  for (const part of String(text).split(/[,;\s]+/)) {
    if (!part) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    let a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > total) return null;
    for (let i = a; i <= b; i++) set.add(i - 1);
  }
  return set.size ? [...set].sort((x, y) => x - y) : null;
}

function rangeGroups(text, total) {
  const groups = [];
  for (const part of String(text).split(/[,;]+/)) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(t);
    if (!m) return null;
    let a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > total) return null;
    groups.push({ a, b });
  }
  return groups.length ? groups : null;
}

function openWatermark(ctx) {
  const doc = ctx.doc();
  const selected = ctx.selectedPages();
  const cur = doc.watermark;
  const spec = cur ? { ...structuredClone(cur), image: cur.image } : { type: "text", text: "FOR APPROVAL", color: "#B3261E", opacity: 0.35, size: "large", dir: "diag", repeat: "once", image: null };
  let pagesMode = cur ? (cur.keys ? "range" : "all") : "all";
  let rangeText = cur && cur.keys ? cur.keys.map((k) => doc.pages.findIndex((p) => p.key === k) + 1).filter((n) => n > 0).join(", ") : "";
  if (pagesMode === "all" && selected.length && !cur) pagesMode = "all";

  const previewPage = doc.pages[Math.max(0, ctx.currentIndex())] || doc.pages[0];
  const g = pageGeom(doc, previewPage);
  const box = { w: 260, h: 160 };
  const k = Math.min(box.w / g.dw, box.h / g.dh);
  const pw = Math.round(g.dw * k), ph = Math.round(g.dh * k);

  const body = h(`<div class="wm-body">
    <div class="wm-preview"><div class="wm-page" style="width:${pw}px;height:${ph}px"><canvas></canvas><svg viewBox="0 0 ${g.dw} ${g.dh}" preserveAspectRatio="none"></svg></div></div>
    <div class="wm-controls">
      <div data-type></div>
      <div data-src></div>
      <div class="wm-row"><span>Colour</span><div class="swatches" data-colors role="radiogroup" aria-label="Colour"></div></div>
      <label class="wm-row"><span>Opacity</span><input type="range" min="5" max="100" step="5" data-op><b class="op-val"></b></label>
      <div class="wm-row"><span>Size</span><div data-size></div></div>
      <div class="wm-row"><span>Direction</span><div data-dir></div></div>
      <div class="wm-row"><span>Repeat</span><div data-repeat></div></div>
      <div class="wm-row last"><span>Pages</span><div data-pages></div></div>
      <div data-range hidden><input class="input" placeholder="For example 1-3, 6" inputmode="numeric" aria-label="Page range"></div>
      <p class="form-error" hidden></p>
    </div>
  </div>`);
  const canvas = body.querySelector("canvas");
  const svg = body.querySelector(".wm-page svg");
  const dpr = Math.min(2.5, devicePixelRatio || 1);
  canvas.style.width = pw + "px";
  canvas.style.height = ph + "px";
  drawPage(doc, previewPage, k * dpr, { x: 0, y: 0, w: pw * dpr, h: ph * dpr }, canvas, null).catch(() => {});
  const paint = () => { svg.innerHTML = spec.type === "image" && !spec.image ? "" : wmSVG(spec, g.dw, g.dh); };

  const typeSeg = segmented([{ value: "text", label: "Text" }, { value: "image", label: "Logo or picture" }], spec.type, (v) => { spec.type = v; renderSrc(); paint(); }, { label: "Watermark type" });
  body.querySelector("[data-type]").appendChild(typeSeg);
  const srcBox = body.querySelector("[data-src]");
  const renderSrc = () => {
    srcBox.innerHTML = "";
    body.querySelector("[data-colors]").parentElement.hidden = spec.type === "image";
    if (spec.type === "text") {
      const inp = h(`<input class="input" aria-label="Watermark text" maxlength="80">`);
      inp.value = spec.text || "";
      inp.addEventListener("input", () => { spec.text = inp.value; paint(); });
      srcBox.appendChild(inp);
    } else {
      const im = spec.image;
      const cls = im ? [im.w / im.h > 1.6 ? "wide" : "", im.dark ? "dark" : ""].join(" ").trim() : "";
      const row = h(`<div class="wm-img-row">${im ? `<img alt="" src="${im.url}" class="${cls}"><span class="ell">${esc(im.name || "Picture")}</span>` : `<span class="note" style="margin:0">Choose what to show:</span>`}
        <button type="button" class="btn small" data-logo>Tesseract logo</button><button type="button" class="btn small" data-pic>Choose a picture</button></div>`);
      row.querySelector("[data-logo]").addEventListener("click", async (e) => {
        const v = await openMenu(e.currentTarget, [
          { label: "Black logo", value: "black" },
          { label: "White logo, for dark pages", value: "white" }
        ], { align: "start" });
        if (!v) return;
        try { spec.image = await logoImage(v); } catch (err) { toast("The logo couldn't be loaded. Try again."); return; }
        renderSrc(); paint();
      });
      row.querySelector("[data-pic]").addEventListener("click", async () => {
        const [f] = await pickFiles({ accept: "image/*" });
        if (!f) return;
        try { spec.image = await pictureImage(f); } catch (e) { toast("That picture couldn't be read."); return; }
        renderSrc(); paint();
      });
      srcBox.appendChild(row);
    }
  };
  renderSrc();

  const colors = body.querySelector("[data-colors]");
  for (const c of ["#6B6B66", "#B3261E", "#1F4E79", "#1C1C1A"]) {
    const b = h(`<button type="button" role="radio" class="sw${c === spec.color ? " on" : ""}" style="--c:${c}" aria-checked="${c === spec.color}" aria-label="Colour"></button>`);
    b.addEventListener("click", () => {
      spec.color = c;
      colors.querySelectorAll(".sw").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
      paint();
    });
    colors.appendChild(b);
  }
  const op = body.querySelector("[data-op]");
  const opVal = body.querySelector(".op-val");
  op.value = Math.round((spec.opacity ?? 0.35) * 100);
  opVal.textContent = op.value + "%";
  op.addEventListener("input", () => { spec.opacity = op.value / 100; opVal.textContent = op.value + "%"; paint(); });
  body.querySelector("[data-size]").appendChild(segmented([{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }], spec.size, (v) => { spec.size = v; paint(); }, { small: true, label: "Size" }));
  body.querySelector("[data-dir]").appendChild(segmented([{ value: "diag", label: "Diagonal" }, { value: "across", label: "Across" }], spec.dir, (v) => { spec.dir = v; paint(); }, { small: true, label: "Direction" }));
  body.querySelector("[data-repeat]").appendChild(segmented([{ value: "once", label: "Once" }, { value: "tile", label: "Tiled" }], spec.repeat, (v) => { spec.repeat = v; paint(); }, { small: true, label: "Repeat" }));
  const rangeBox = body.querySelector("[data-range]");
  const rangeInput = rangeBox.querySelector("input");
  rangeInput.value = rangeText;
  const pageOpts = [{ value: "all", label: `All ${doc.pages.length}` }];
  if (selected.length) pageOpts.push({ value: "sel", label: `Selected (${selected.length})` });
  pageOpts.push({ value: "range", label: "Range" });
  body.querySelector("[data-pages]").appendChild(segmented(pageOpts, pagesMode, (v) => { pagesMode = v; rangeBox.hidden = v !== "range"; if (v === "range") rangeInput.focus(); }, { small: true, label: "Pages" }));
  rangeBox.hidden = pagesMode !== "range";
  paint();

  const foot = h(`<div class="foot-row">${cur ? `<button class="btn danger-outline" type="button" data-remove>Remove</button>` : `<button class="btn" type="button" data-cancel>Cancel</button>`}<button class="btn primary" type="button" data-ok>${cur ? "Update watermark" : "Add watermark"}</button></div>`);
  const sheet = openSheet({ title: "Watermark", body, foot, full: true });
  const err = body.querySelector(".form-error");
  foot.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-cancel")) { sheet.close(); return; }
    if (b.hasAttribute("data-remove")) {
      doc.commit();
      doc.watermark = null;
      ctx.marksChanged();
      sheet.close();
      toast("Watermark removed", { action: { label: "Undo", fn: () => doc.undo() } });
      return;
    }
    if (spec.type === "text" && !String(spec.text || "").trim()) { err.textContent = "Type the watermark text."; err.hidden = false; return; }
    if (spec.type === "image" && !spec.image) { err.textContent = "Choose the logo or a picture."; err.hidden = false; return; }
    let keys = null;
    if (pagesMode === "sel") keys = selected.map((p) => p.key);
    else if (pagesMode === "range") {
      const idx = parseRange(rangeInput.value, doc.pages.length);
      if (!idx) { err.textContent = `Type pages between 1 and ${doc.pages.length}, like 1-3, 6.`; err.hidden = false; return; }
      keys = idx.map((i) => doc.pages[i].key);
    }
    doc.commit();
    doc.watermark = { ...spec, keys };
    ctx.marksChanged();
    sheet.close();
    toast(cur ? "Watermark updated" : "Watermark added", { action: { label: "Undo", fn: () => doc.undo() } });
  });
}

/* ---------- Reduce file size ---------- */

function openReduce(ctx) {
  const doc = ctx.doc();
  preloadEngine();
  let size = 0;
  for (const s of doc.sources.values()) size += s.kind === "pdf" ? s.bytes.length : s.kind === "image" ? s.blob.size : 0;
  let choice = "balanced";
  const opts = [
    { v: "small", t: "Smallest", d: "For WhatsApp. Photos and scans at 100 dpi.", dpi: 100, q: 0.6 },
    { v: "balanced", t: "Balanced", d: "For email. Photos and scans at 150 dpi.", dpi: 150, q: 0.72 },
    { v: "print", t: "Print quality", d: "Photos and scans at 220 dpi.", dpi: 220, q: 0.85 }
  ];
  const body = h(`<div><p class="note" style="margin-top:0">Now about <b>${formatSize(size)}</b>, ${doc.pages.length} page${doc.pages.length === 1 ? "" : "s"}.</p><div data-opts></div>
    <p class="note">Lines and text stay sharp at every setting. Only photos and scanned pages get smaller. You'll see the new size before you save.</p></div>`);
  const box = body.querySelector("[data-opts]");
  for (const o of opts) {
    const row = h(`<label class="radio-card${o.v === choice ? " on" : ""}"><input type="radio" name="q" ${o.v === choice ? "checked" : ""}><span><b>${o.t}</b><small>${o.d}</small></span></label>`);
    row.querySelector("input").addEventListener("change", () => { choice = o.v; box.querySelectorAll(".radio-card").forEach((r) => r.classList.toggle("on", r === row)); });
    box.appendChild(row);
  }
  const foot = h(`<div class="foot-row"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="button" data-ok>Reduce size</button></div>`);
  const sheet = openSheet({ title: "Reduce file size", body, foot });
  foot.querySelector("[data-cancel]").addEventListener("click", () => sheet.close());
  foot.querySelector("[data-ok]").addEventListener("click", async () => {
    const o = opts.find((x) => x.v === choice);
    sheet.close();
    const b = busy("Making a smaller copy…");
    try {
      const { bytes, blurs, overlays } = await buildPdf(doc, doc.pages, { layers: "all", comments: true, title: doc.name });
      let src = bytes;
      if (blurs.length) src = await engine("finalize", [bytes, { blurs, overlays, password: null }], { onProgress: (t) => b.set(t), transfer: [bytes.buffer] });
      const before = src.length;
      let inches = 8.27;
      for (const p of doc.pages) { const ps = doc.pageSize(p); inches = Math.max(inches, Math.max(ps.w, ps.h) / 72); }
      const r = await engine("reduce", [src, { dpi: o.dpi, quality: o.q, pageInches: inches, password: doc.password }], { onProgress: (t) => b.set(t), transfer: [src.buffer] });
      b.close();
      const file = new File([r.bytes], `${doc.name} (smaller).pdf`, { type: "application/pdf" });
      const msg = r.changed
        ? `${formatSize(Math.max(size, before))} → ${formatSize(r.bytes.length)}.`
        : `There were no large photos or scans to shrink, so it's ${formatSize(r.bytes.length)}.`;
      openResultSheet("Smaller copy ready", [file], msg);
    } catch (err) {
      b.close();
      console.error(err);
      toast(err && err.message && err.code === "offline" ? err.message : "The smaller copy couldn't be made. Try again.", { ms: 6000 });
    }
  });
}

/* ---------- Split ---------- */

function openSplit(ctx) {
  const doc = ctx.doc();
  const n = doc.pages.length;
  const multiFile = new Set(doc.pages.filter((p) => doc.src(p).kind !== "blank").map((p) => p.src)).size > 1;
  let mode = "ranges";
  let every = 2;
  const body = h(`<div><div data-opts></div><div class="group-label" data-count></div><ul class="file-list" data-names></ul><p class="form-error" hidden></p></div>`);
  const box = body.querySelector("[data-opts]");
  const opts = [
    { v: "each", t: "Every page", d: `${n} PDFs, one page each` },
    { v: "every", t: "Every few pages", d: "Choose how many pages go in each file" },
    { v: "ranges", t: "By page ranges", d: "Each range becomes one PDF" }
  ];
  if (multiFile) opts.push({ v: "files", t: "One PDF per original file", d: "Each file you combined comes back out" });
  const rangeInput = h(`<input class="input" inputmode="numeric" aria-label="Page ranges" placeholder="For example 1-3, 4-8, 9-${n}">`);
  rangeInput.value = n >= 3 ? `1-${Math.ceil(n / 3)}, ${Math.ceil(n / 3) + 1}-${n}` : `1-${n}`;
  const stepper = h(`<div class="stepper"><button type="button" aria-label="Fewer pages">−</button><span></span><button type="button" aria-label="More pages">+</button></div>`);
  const [minus, plus] = stepper.querySelectorAll("button");
  minus.addEventListener("click", () => { every = Math.max(1, every - 1); update(); });
  plus.addEventListener("click", () => { every = Math.min(n, every + 1); update(); });
  rangeInput.addEventListener("input", () => update());
  for (const o of opts) {
    const card = h(`<div class="radio-card${o.v === mode ? " on" : ""}"><label class="radio-line"><input type="radio" name="split" ${o.v === mode ? "checked" : ""}><span><b>${o.t}</b><small>${o.d}</small></span></label></div>`);
    if (o.v === "ranges") card.appendChild(h(`<div class="card-extra"></div>`)).appendChild(rangeInput);
    if (o.v === "every") card.appendChild(h(`<div class="card-extra"></div>`)).appendChild(stepper);
    card.querySelector("input").addEventListener("change", () => { mode = o.v; box.querySelectorAll(".radio-card").forEach((r) => r.classList.toggle("on", r === card)); update(); });
    box.appendChild(card);
  }
  const groups = () => {
    if (mode === "each") return doc.pages.map((p, i) => ({ pages: [p], label: `page ${i + 1}` }));
    if (mode === "every") {
      const out = [];
      for (let i = 0; i < n; i += every) out.push({ pages: doc.pages.slice(i, i + every), label: every === 1 || i + 1 === Math.min(n, i + every) ? `page ${i + 1}` : `pages ${i + 1}-${Math.min(n, i + every)}` });
      return out;
    }
    if (mode === "files") {
      // Blank pages you inserted stay with the file they were added to.
      const by = new Map();
      let lastReal = null;
      const firstReal = (doc.pages.find((p) => doc.src(p).kind !== "blank") || doc.pages[0]).src;
      for (const p of doc.pages) {
        const blank = doc.src(p).kind === "blank";
        if (!blank) lastReal = p.src;
        const key = blank ? (lastReal ?? firstReal) : p.src;
        if (!by.has(key)) by.set(key, []);
        by.get(key).push(p);
      }
      return [...by.entries()].map(([sid, pages]) => ({ pages, name: baseName(doc.sources.get(sid).name) }));
    }
    const rg = rangeGroups(rangeInput.value, n);
    if (!rg) return null;
    return rg.map(({ a, b }) => ({ pages: doc.pages.slice(a - 1, b), label: a === b ? `page ${a}` : `pages ${a}-${b}` }));
  };
  const nameOf = (gr) => (gr.name ? gr.name : `${doc.name} - ${gr.label}`) + ".pdf";
  const count = body.querySelector("[data-count]");
  const names = body.querySelector("[data-names]");
  const err = body.querySelector(".form-error");
  const foot = h(`<div class="foot-row"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="button" data-ok>Split</button></div>`);
  const okBtn = foot.querySelector("[data-ok]");
  function update() {
    stepper.querySelector("span").textContent = `${every} page${every === 1 ? "" : "s"} each`;
    const gs = groups();
    err.hidden = true;
    if (!gs) {
      count.textContent = "";
      names.innerHTML = "";
      err.textContent = `Type ranges between 1 and ${n}, separated by commas, like 1-3, 4-8.`;
      err.hidden = false;
      okBtn.disabled = true;
      return;
    }
    okBtn.disabled = false;
    okBtn.textContent = `Split into ${gs.length} PDF${gs.length === 1 ? "" : "s"}`;
    count.textContent = `You'll get ${gs.length} PDF${gs.length === 1 ? "" : "s"}`;
    names.innerHTML = gs.slice(0, 5).map((gr) => `<li>${icon("file")}<span>${esc(nameOf(gr))}</span></li>`).join("") + (gs.length > 5 ? `<li><span>and ${gs.length - 5} more</span></li>` : "");
  }
  const sheet = openSheet({ title: "Split into files", body, foot });
  update();
  foot.querySelector("[data-cancel]").addEventListener("click", () => sheet.close());
  okBtn.addEventListener("click", async () => {
    const gs = groups();
    if (!gs) return;
    sheet.close();
    const b = busy("Splitting…");
    try {
      const files = [];
      for (let i = 0; i < gs.length; i++) {
        b.set(`Making PDF ${i + 1} of ${gs.length}…`);
        const bytes = await exportPdf(doc, gs[i].pages, { layers: "all", comments: true, title: nameOf(gs[i]).replace(/\.pdf$/, "") });
        files.push(new File([bytes], nameOf(gs[i]), { type: "application/pdf" }));
      }
      b.close();
      openResultSheet(`${files.length} PDF${files.length === 1 ? "" : "s"} ready`, files);
    } catch (e) {
      b.close();
      console.error(e);
      toast(e && e.code === "offline" ? e.message : "Splitting didn't work. Try again.", { ms: 6000 });
    }
  });
}

/* ---------- Recognise text ---------- */

async function openOcr(ctx) {
  const doc = ctx.doc();
  const chosen = new Set(["eng"]);
  let scope = "all";
  const body = h(`<div><p class="note" style="margin-top:0">Reads scanned pages so you can search, select and copy their text. It all happens on this phone.</p>
    <div class="group-label">Languages</div><div data-langs></div>
    <div class="group-label">Pages</div><div data-scope></div></div>`);
  const langsBox = body.querySelector("[data-langs]");
  const renderLangs = async () => {
    langsBox.innerHTML = "";
    for (const l of LANGS) {
      const ready = await langReady(l.code);
      const row = h(`<div class="lang-row"><label><input type="checkbox" ${chosen.has(l.code) ? "checked" : ""}><span>${l.name}</span></label>${ready ? `<small>Ready</small>` : `<button type="button" class="btn small outline">Download · ${l.mb} MB</button>`}</div>`);
      row.querySelector("input").addEventListener("change", (e) => { if (e.target.checked) chosen.add(l.code); else chosen.delete(l.code); });
      const dl = row.querySelector("button");
      if (dl) dl.addEventListener("click", async () => {
        dl.disabled = true;
        dl.textContent = "Downloading…";
        try { await downloadLang(l.code); chosen.add(l.code); } catch (e) { toast("The download didn't finish. Check your internet and try again."); }
        renderLangs();
      });
      langsBox.appendChild(row);
    }
  };
  await renderLangs();
  body.querySelector("[data-scope]").appendChild(segmented([{ value: "all", label: `All ${doc.pages.length} pages` }, { value: "one", label: "This page" }], scope, (v) => { scope = v; }));
  const foot = h(`<div class="foot-row"><button class="btn primary" type="button" data-ok>Recognise text</button></div>`);
  const sheet = openSheet({ title: "Recognise text", body, foot });
  foot.querySelector("[data-ok]").addEventListener("click", async () => {
    const langs = LANGS.map((l) => l.code).filter((c) => chosen.has(c));
    if (!langs.length) { toast("Choose at least one language."); return; }
    sheet.close();
    const b = busy("Getting the languages ready…");
    try {
      for (const c of langs) if (!(await langReady(c))) { b.set(`Downloading ${LANGS.find((l) => l.code === c).name}…`); await downloadLang(c); }
      const pages = scope === "all" ? doc.pages : [doc.pages[Math.max(0, ctx.currentIndex())]];
      const r = await recognize(doc, pages, langs, (t) => b.set(t));
      b.close();
      doc.dirty = true;
      ctx.textChanged(pages);
      toast(r.withText ? `Text recognised on ${r.withText} page${r.withText === 1 ? "" : "s"}. Press and hold on text to select it.` : "No text was found on these pages.", { ms: 6000 });
    } catch (e) {
      b.close();
      console.error(e);
      toast(navigator.onLine === false ? "This needs the internet the first time, to download the text reader." : "Text recognition didn't work. Try again.", { ms: 6000 });
    }
  });
}

/* ---------- Save text and images ---------- */

async function saveText(ctx) {
  const doc = ctx.doc();
  const b = busy("Collecting the text…");
  try {
    const text = await documentText(doc);
    b.close();
    const file = new File([text], `${doc.name}.txt`, { type: "text/plain" });
    const empty = !/[^\s]/.test(text.replace(/Page \d+|\(no text found\)/g, ""));
    openResultSheet("Text ready", [file], empty ? "No text was found. For scanned pages, use Recognise text first." : "");
  } catch (e) {
    b.close();
    toast("The text couldn't be saved. Try again.");
  }
}

async function saveImages(ctx) {
  const doc = ctx.doc();
  const b = busy("Finding images…");
  try {
    const files = [];
    const seen = new Set();
    for (const p of doc.pages) {
      const s = doc.src(p);
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      const prefix = baseName(s.name);
      if (s.kind === "image") {
        files.push(new File([s.blob], s.name || `${prefix}.jpg`, { type: s.blob.type || "image/jpeg" }));
      } else if (s.kind === "pdf") {
        const bytes = s.bytes.slice();
        const imgs = await engine("images", [bytes], { onProgress: (t) => b.set(t), transfer: [bytes.buffer] });
        for (const f of imgs) files.push(new File([f.bytes], `${prefix}-${f.name}`, { type: f.type }));
      }
    }
    b.close();
    if (!files.length) { toast("There are no pictures in this PDF. Drawings made of lines aren't pictures."); return; }
    openResultSheet(`${files.length} image${files.length === 1 ? "" : "s"} found`, files);
  } catch (e) {
    b.close();
    console.error(e);
    toast(e && e.code === "offline" ? e.message : "The images couldn't be saved. Try again.", { ms: 6000 });
  }
}
