// Pictures in Mark up: bringing one in (photos, camera, a page of a PDF), and the picture's
// options: look, border, crop, exact size, flip, reset and making it part of the page.
// The picture itself (model, drawing, PDF) is in pics.js; moving and resizing it is in markup.js.
import { newId, loadSource, closeSource } from "./doc.js";
import {
  settingsOf, pictureFromFile, pictureFromPdfPage, registerPic, newImgSettings, naturalSize, PictureError,
  picSVG, fullBox, frameOf, turned, resetPic, paperSize, picAngle, withCrop, DEFAULTS
} from "./pics.js";
import { apply } from "./geom.js";
import { PEN_COLORS, thickFactor, levelForWidth, levelPx } from "./shapes.js";
import { icon, esc, h, segmented, openSheet, openMenu, toast, busy, pushLayer, closeLayer, confirmDialog, passwordDialog } from "./ui.js";
import { pickFiles } from "./platform.js";

const MM = 72 / 25.4;

/* ---------- bringing a picture in ---------- */

export function openPictureMenu(mk) {
  const rows = [
    { how: "file", ic: "image", title: "Photo or picture", text: "From your gallery or files: JPG, PNG, HEIC, TIFF, WebP" },
    { how: "camera", ic: "camera", title: "Take a photo", text: "A signature, a logo or a sketch on paper" },
    { how: "pdf", ic: "pagepic", title: "Page of a PDF", text: "One page, placed as a picture" }
  ];
  const body = h(`<div class="tools-body"></div>`);
  let sheet;
  for (const r of rows) {
    const b = h(`<button type="button" class="tool-row"><span class="tool-ic">${icon(r.ic)}</span><span class="tool-text"><b>${esc(r.title)}</b><small>${esc(r.text)}</small></span>${icon("chev")}</button>`);
    b.addEventListener("click", () => { sheet.close(); setTimeout(() => insertPicture(mk, r.how), 30); });
    body.appendChild(b);
  }
  body.appendChild(h(`<p class="note tools-foot">It lands on the page at its own size. Drag a corner to resize it, or the round handle to turn it. For a signature on paper, use Look → Remove white background.</p>`));
  sheet = openSheet({ title: "Add a picture", body });
  sheet.body.style.padding = "6px 0 12px";
}

async function insertPicture(mk, how) {
  const doc = mk.doc;
  if (!doc) return;
  const files = await pickFiles(how === "pdf"
    ? { accept: "application/pdf,.pdf" }
    : { accept: "image/*,.heic,.heif,.tif,.tiff", capture: how === "camera" ? "environment" : null });
  const file = files && files[0];
  if (!file) return;
  let b = busy("Adding the picture…");
  let src = null;
  try {
    let pic;
    const isPdf = how === "pdf" || /\.pdf$/i.test(file.name || "") || file.type === "application/pdf";
    if (isPdf) {
      src = await loadSource(file, {
        askPassword: async (name, retry) => { b.close(); const pw = await passwordDialog(name, retry); b = busy("Adding the picture…"); return pw; }
      });
      if (!src) { b.close(); return; }
      if (src.kind !== "pdf") throw new PictureError("This file isn't a PDF.");
      let index = 0;
      if (src.pages.length > 1) {
        b.close();
        index = await pickPdfPage(src, file.name);
        if (index == null) return;
        b = busy("Adding the picture…");
      }
      pic = await pictureFromPdfPage(src, index);
    } else {
      try {
        pic = await pictureFromFile(file);
      } catch (e) {
        if (e instanceof PictureError && e.message === "pdf") { b.close(); b = { close() {} }; return insertPictureFromPdfFile(mk, file); }
        throw e;
      }
    }
    const hash = await registerPic(doc, pic);
    b.close();
    placePicture(mk, hash, pic);
  } catch (e) {
    b.close();
    console.error(e);
    toast(e instanceof PictureError || (e && e.kind) ? e.message : "The picture couldn't be added.", { ms: 5000 });
  } finally {
    if (src) closeSource(src);
  }
}

async function insertPictureFromPdfFile(mk, file) {
  // a PDF picked as a picture: take one of its pages
  const doc = mk.doc;
  let b = busy("Adding the picture…");
  let src = null;
  try {
    src = await loadSource(file, {
      askPassword: async (name, retry) => { b.close(); const pw = await passwordDialog(name, retry); b = busy("Adding the picture…"); return pw; }
    });
    if (!src) { b.close(); return; }
    let index = 0;
    if (src.pages.length > 1) {
      b.close();
      index = await pickPdfPage(src, file.name);
      if (index == null) return;
      b = busy("Adding the picture…");
    }
    const pic = await pictureFromPdfPage(src, index);
    const hash = await registerPic(doc, pic);
    b.close();
    placePicture(mk, hash, pic);
  } catch (e) {
    b.close();
    console.error(e);
    toast(e && e.message ? e.message : "The picture couldn't be added.", { ms: 5000 });
  } finally {
    if (src) closeSource(src);
  }
}

/** Which page of a PDF? Small previews to tap. Resolves the page index, or null. */
function pickPdfPage(src, name) {
  return new Promise((resolve) => {
    let result = null;
    const body = h(`<div class="pick-pages"><p class="note">Tap the page to place as a picture.</p><div class="pick-grid"></div></div>`);
    const grid = body.querySelector(".pick-grid");
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        drawThumb(src, Number(en.target.dataset.i), en.target.querySelector("canvas"));
      }
    }, { root: null, rootMargin: "200px" });
    src.pages.forEach((info, i) => {
      const r = info.view;
      const turned = (info.rotate || 0) % 180 === 90;
      const ar = turned ? (r[2] - r[0]) / (r[3] - r[1]) : (r[3] - r[1]) / (r[2] - r[0]);
      const b = h(`<button type="button" class="pick-page" data-i="${i}"><span class="pick-thumb" style="aspect-ratio:1/${ar.toFixed(4)}"><canvas></canvas></span><span>Page ${i + 1}</span></button>`);
      b.addEventListener("click", () => { result = i; sheet.close(); });
      grid.appendChild(b);
      io.observe(b);
    });
    const sheet = openSheet({ title: name ? `Page of “${name}”` : "Pick a page", body, tall: true, onClose: () => { io.disconnect(); resolve(result); } });
  });
}

async function drawThumb(src, i, canvas) {
  try {
    const page = await src.pdf.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1, rotation: src.pages[i].rotate });
    const k = 220 / Math.max(vp1.width, vp1.height);
    const vp = page.getViewport({ scale: k, rotation: src.pages[i].rotate });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), canvas, viewport: vp, background: "#ffffff" }).promise;
  } catch (e) { /* the source was closed: no preview */ }
}

/** Puts a picture on the page in the middle of the screen, at its own size, and selects it. */
export function placePicture(mk, hash, pic) {
  const doc = mk.doc;
  const vit = mk.centerPage();
  if (!vit) return;
  const g = mk.viewer.geom(vit);
  const kd = Math.sqrt(Math.abs(g.b2d[0] * g.b2d[3] - g.b2d[1] * g.b2d[2]));
  const pageW = g.dw / kd / g.pt, pageH = g.dh / kd / g.pt; // the page as shown, in points
  const { w, h: hh } = naturalSize(pic.pw, pic.ph, pic.dpi, pageW, pageH);
  const r = mk.viewer.root.getBoundingClientRect();
  let [cx, cy] = mk.viewer.toBase(vit, r.left + r.width / 2, r.top + r.height * 0.42);
  // the whole picture on the page, where there is room for it
  const a = ((360 - g.R) % 360) * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
  const m = [g.pt * co, g.pt * si, -g.pt * si, g.pt * co, cx, cy];
  const ext = (vx, vy) => Math.abs(m[0] * vx) + Math.abs(m[2] * vy);
  const eyt = (vx, vy) => Math.abs(m[1] * vx) + Math.abs(m[3] * vy);
  const hx = ext(w / 2, hh / 2), hy = eyt(w / 2, hh / 2);
  const c = g.crop;
  const fit = (v, half, lo, hi) => (hi - lo > 2 * half ? Math.max(lo + half, Math.min(hi - half, v)) : (lo + hi) / 2);
  m[4] = fit(cx, hx, c.x0 * g.W, c.x1 * g.W);
  m[5] = fit(cy, hy, c.y0 * g.H, c.y1 * g.H);
  const layer = doc.ensureLayer();
  doc.commit();
  const it = { id: newId(), kind: "pic", w, h: hh, m, img: newImgSettings(hash, pic), color: "#1F2328", width: 1, opacity: 1, layer: layer.id };
  vit.p.items.push(it);
  mk.tool = "select";
  mk.paintTools();
  mk.sel = { key: vit.p.key, id: it.id };
  mk.updateChip();
  mk.changed();
  mk.renderOptions();
}

/* ---------- the picture's options ---------- */

function editPic(mk, fn) {
  mk.editSelected((it) => {
    const n = fn(it);
    if (n && n !== it) { for (const k of Object.keys(it)) if (!(k in n)) delete it[k]; Object.assign(it, n); }
  });
}

function setImg(mk, patch) {
  editPic(mk, (it) => { it.img = { ...(it.img || {}), ...patch }; });
}

/** The bar under the page for a selected picture. */
export function appendPicOptions(mk, o, it) {
  const s = settingsOf(it);
  const look = h(`<button type="button" class="chip-btn tight">${icon("look")}<span>Look</span></button>`);
  look.addEventListener("click", () => openLook(mk));
  o.appendChild(look);
  const bd = h(`<button type="button" role="switch" aria-checked="${s.border}" class="chip-btn toggle tight${s.border ? " on" : ""}">${icon("border")}<span>Border</span></button>`);
  bd.addEventListener("click", () => setImg(mk, { border: !s.border }));
  o.appendChild(bd);
  if (s.border) {
    const key = mk.sel.key;
    const unit = mk.unitFor(key);
    const scale = Math.hypot(it.m[0], it.m[1]) || 1;
    const thick = levelForWidth((it.width || 1) * scale, unit);
    o.appendChild(mk.styleButton(it.color || "#1F2328", levelPx(thick), (e) => mk.openStylePicker(e.currentTarget, {
      colors: ["#1F2328", ...PEN_COLORS.filter((c) => c !== "#1C1C1A")], color: it.color || "#1F2328", thick,
      onChange: ({ color, thick: t }) => editPic(mk, (x) => {
        if (color) x.color = color;
        if (t) x.width = (thickFactor(t) * unit) / (Math.hypot(x.m[0], x.m[1]) || 1);
      })
    }), "Border colour and thickness"));
  }
  const keep = keepProportions();
  const kp = h(`<button type="button" role="switch" aria-checked="${keep}" class="chip-btn toggle tight${keep ? " on" : ""}" title="On: corners keep the picture's proportions. Off: corners stretch it freely.">${icon("link")}<span>Keep proportions</span></button>`);
  kp.addEventListener("click", () => {
    setKeepProportions(!keepProportions());
    mk.renderOptions();
    if (keepToast) keepToast.remove();
    keepToast = toast(keepProportions() ? "Corners keep the proportions" : "Corners stretch freely", { ms: 1800 });
  });
  o.appendChild(kp);
  const more = h(`<button type="button" class="chip-btn tight">${icon("more")}<span>More</span></button>`);
  more.addEventListener("click", () => picMore(mk, more));
  o.appendChild(more);
  const l = mk.doc.layer(it.layer);
  const lb = h(`<button type="button" class="chip-btn grow-btn">${icon("layers")}<span class="ell">${esc(l ? l.name : "Layer")}</span>${icon("chevdown")}</button>`);
  lb.addEventListener("click", async () => {
    const v = await openMenu(lb, mk.doc.layers.map((x) => ({ label: x.name, value: x.id, checked: x.id === it.layer })), { above: true, align: "end" });
    if (v) mk.editSelected((x) => { x.layer = v; });
  });
  o.appendChild(lb);
}

async function picMore(mk, anchor) {
  const it = mk.selectedItem();
  if (!it) return;
  const s = settingsOf(it);
  const v = await openMenu(anchor, [
    { label: "Flip left to right", icon: "flip", value: "fh", checked: s.flip[0] },
    { label: "Flip upside down", icon: "flipv", value: "fv", checked: s.flip[1] },
    { label: "Exact size and angle…", icon: "size", value: "size" },
    { divider: true },
    { label: "Reset picture", icon: "undo", value: "reset" },
    { label: "Make part of page", icon: "pagepic", value: "flat" }
  ], { above: true, align: "end" });
  if (!v) return;
  if (v === "fh") setImg(mk, { flip: [!s.flip[0], s.flip[1]] });
  else if (v === "fv") setImg(mk, { flip: [s.flip[0], !s.flip[1]] });
  else if (v === "size") openPicSize(mk);
  else if (v === "reset") {
    const vit = mk.viewer.itemFor(mk.sel.key);
    if (!vit) return;
    const g = mk.viewer.geom(vit);
    editPic(mk, (x) => resetPic(x, g.pt, g.R));
  } else if (v === "flat") {
    const ok = await confirmDialog({ title: "Make part of the page?", message: "The picture becomes part of the page when you save: it can't be moved or changed after that, here or in the Windows app. Undo brings it back for now.", okText: "Make part of page" });
    if (!ok) return;
    mk.editSelected((x) => { x.flat = true; });
    mk.select(null);
    toast("Now part of the page", { ms: 3000, action: { label: "Undo", fn: () => mk.doc.undo() } });
  }
}

/** Turn a quarter clockwise. */
export function turnPic(mk) {
  editPic(mk, (it) => turned(it, 90));
}

/* ---------- look: colour, paper, brightness, contrast, opacity ---------- */

function bringIntoView(mk, frac = 0.45) {
  const it = mk.selectedItem();
  const vit = it && mk.viewer.itemFor(mk.sel.key);
  if (!vit) return;
  const [cx, cy] = mk.viewer.toClient(vit, ...apply(frameOf(it), 0, 0));
  const r = mk.viewer.root.getBoundingClientRect();
  const want = r.top + r.height * frac * 0.6;
  if (cy > r.top + r.height * frac) mk.viewer.panBy(0, cy - want);
  void cx;
}

function openLook(mk) {
  const it0 = mk.selectedItem();
  if (!it0) return;
  bringIntoView(mk);
  const key = mk.sel.key, id = mk.sel.id;
  let committed = false;
  const s0 = settingsOf(it0);
  const panel = h(`<div class="pic-panel" role="dialog" aria-label="Look">
    <div class="pic-panel-head"><b>Look</b><button type="button" class="btn link-btn" data-reset>Reset look</button><button type="button" class="btn primary small" data-done>Done</button></div>
    <div class="pic-panel-body">
      <div data-seg></div>
      <button type="button" role="switch" class="switch-row pic-white"><span class="grow"><span>Remove white background</span><small>For signatures and logos on paper</small></span><span class="switch"></span></button>
      <label class="wm-row"><span>Brightness</span><input type="range" min="-100" max="100" step="1" data-k="bright"><b class="op-val"></b></label>
      <label class="wm-row"><span>Contrast</span><input type="range" min="-100" max="100" step="1" data-k="contrast"><b class="op-val"></b></label>
      <label class="wm-row last"><span>Opacity</span><input type="range" min="10" max="100" step="5" data-k="opacity"><b class="op-val"></b></label>
    </div></div>`);
  const cur = () => {
    const p = mk.doc.pages.find((x) => x.key === key);
    return p ? p.items.find((x) => x.id === id) : null;
  };
  const apply2 = (fn) => {
    const it = cur();
    if (!it) return;
    if (!committed) { mk.doc.commit(); committed = true; }
    fn(it);
    mk.changed();
  };
  const seg = segmented([{ value: "color", label: "Colour" }, { value: "grey", label: "Grey" }, { value: "bw", label: "Black & white" }], s0.look,
    (v) => apply2((it) => { it.img = { ...it.img, look: v }; }), { label: "Colour" });
  seg.classList.add("pic-look-seg");
  panel.querySelector("[data-seg]").appendChild(seg);
  const wb = panel.querySelector(".pic-white");
  const paintWhite = (on) => { wb.setAttribute("aria-checked", on); wb.querySelector(".switch").classList.toggle("on", on); };
  paintWhite(s0.white);
  wb.addEventListener("click", () => {
    const on = !settingsOf(cur()).white;
    paintWhite(on);
    apply2((it) => { it.img = { ...it.img, white: on }; });
  });
  const ranges = [...panel.querySelectorAll("input[type=range]")];
  const show = () => {
    const it = cur();
    if (!it) return;
    const s = settingsOf(it);
    for (const r of ranges) {
      const k = r.dataset.k;
      const v = k === "opacity" ? Math.round((it.opacity == null ? 1 : it.opacity) * 100) : s[k];
      r.value = v;
      r.parentElement.querySelector(".op-val").textContent = k === "opacity" ? `${v}%` : v > 0 ? `+${v}` : `${v}`;
    }
    seg.setValue(s.look);
    paintWhite(s.white);
  };
  let timer = null;
  for (const r of ranges) {
    r.addEventListener("input", () => {
      const k = r.dataset.k;
      const v = Number(r.value);
      r.parentElement.querySelector(".op-val").textContent = k === "opacity" ? `${v}%` : v > 0 ? `+${v}` : `${v}`;
      clearTimeout(timer);
      timer = setTimeout(() => apply2((it) => {
        if (k === "opacity") it.opacity = v / 100;
        else it.img = { ...it.img, [k]: v };
      }), k === "opacity" ? 0 : 140);
    });
  }
  panel.querySelector("[data-reset]").addEventListener("click", () => {
    apply2((it) => { it.img = { ...it.img, look: "color", white: false, bright: 0, contrast: 0 }; it.opacity = 1; });
    show();
  });
  show();
  mk.screen.classList.add("pic-panel-open");
  mk.views.appendChild(panel);
  const layer = pushLayer({ onClose: () => { clearTimeout(timer); panel.remove(); mk.screen.classList.remove("pic-panel-open"); mk.panel = null; mk.renderOptions(); mk.drawSelection(); } });
  mk.panel = { layer };
  panel.querySelector("[data-done]").addEventListener("click", () => closeLayer(layer));
}

/* ---------- crop ---------- */

/** Crop mode: the whole picture shows faintly, the edges of the part that stays can be dragged. */
const KEEP_KEY = "tpt-pic-keep";
let keepToast = null;
let keepNow = null; // when the phone's storage can't be used
/** Do a picture's corners keep its proportions? (on unless switched off; remembered) */
export function keepProportions() {
  try { return localStorage.getItem(KEEP_KEY) !== "0"; } catch (e) { return keepNow !== false; }
}
export function setKeepProportions(on) {
  keepNow = !!on;
  try { localStorage.setItem(KEEP_KEY, on ? "1" : "0"); } catch (e) { /* kept for now only */ }
}

/** Skew: while it's on, dragging a side of the picture slants it (as Ctrl + a side on Windows). */
export function startSkew(mk) {
  const it = mk.selectedItem();
  if (!it) return;
  const key = mk.sel.key;
  const panel = h(`<div class="pic-panel skew" role="dialog" aria-label="Skew">
    <div class="pic-panel-head"><span class="pic-panel-note">${icon("skew")}<span>Drag a side to slant the picture.</span></span></div>
    <div class="pic-panel-foot"><button type="button" class="btn link-btn" data-clear>Straighten</button><span class="grow"></span><button type="button" class="btn primary" data-done>Done</button></div></div>`);
  mk.screen.classList.add("pic-panel-open");
  mk.views.appendChild(panel);
  const layer = pushLayer({
    onClose: () => {
      panel.remove();
      mk.screen.classList.remove("pic-panel-open");
      mk.skewing = null;
      mk.renderOptions();
      mk.drawSelection();
    }
  });
  mk.skewing = { key, id: it.id, layer };
  panel.querySelector("[data-done]").addEventListener("click", () => closeLayer(layer));
  panel.querySelector("[data-clear]").addEventListener("click", () => {
    if (!mk.selectedItem()) return;
    setImg(mk, { skew: [0, 0] });
  });
  mk.drawSelection();
}

export function startCrop(mk) {
  const it = mk.selectedItem();
  if (!it) return;
  const key = mk.sel.key;
  const panel = h(`<div class="pic-panel crop" role="dialog" aria-label="Crop">
    <div class="pic-panel-head"><span class="pic-panel-note">${icon("crop")}<span>Drag the edges. The faint part is cut off.</span></span></div>
    <div class="pic-panel-foot"><button type="button" class="btn link-btn" data-clear>Show all</button><span class="grow"></span><button type="button" class="btn primary" data-done>Done</button></div></div>`);
  mk.screen.classList.add("pic-panel-open");
  mk.views.appendChild(panel);
  const layer = pushLayer({
    onClose: () => {
      panel.remove();
      mk.screen.classList.remove("pic-panel-open");
      mk.cropping = null;
      mk.viewer.setLive(key, "");
      mk.renderOptions();
      mk.drawSelection();
    }
  });
  mk.cropping = { key, id: it.id, layer };
  panel.querySelector("[data-done]").addEventListener("click", () => closeLayer(layer));
  panel.querySelector("[data-clear]").addEventListener("click", () => {
    const x = mk.selectedItem();
    if (!x) return;
    editPic(mk, (y) => withCrop(y, [0, 0, 0, 0]));
    showCropLive(mk);
  });
  showCropLive(mk);
  mk.drawSelection();
}

/** The faint whole picture behind the part that stays. */
export function showCropLive(mk) {
  if (!mk.cropping) return;
  const it = mk.selectedItem();
  if (!it) return;
  const [x0, y0, x1, y1] = fullBox(it);
  const s = settingsOf(it);
  const fx = s.flip[0] ? -1 : 1, fy = s.flip[1] ? -1 : 1;
  const F = frameOf(it);
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => apply(F, x * fx, y * fy));
  const vit = mk.viewer.itemFor(mk.cropping.key);
  const bpp = vit ? mk.viewer.basePerPx(vit) : 1;
  const outline = `<path d="M${pts.map((p) => p.join(" ")).join("L")}Z" fill="none" stroke="#1F4E79" stroke-width="${bpp * 1.2}" stroke-dasharray="${bpp * 5} ${bpp * 4}"/>`;
  mk.viewer.setLive(mk.cropping.key, picSVG(mk.doc, it, { whole: true, opacity: 0.32, onReady: () => showCropLive(mk) }) + outline);
}

/* ---------- exact size and angle ---------- */

function openPicSize(mk) {
  const it = mk.selectedItem();
  if (!it) return;
  const vit = mk.viewer.itemFor(mk.sel.key);
  if (!vit) return;
  const g = mk.viewer.geom(vit);
  const s = settingsOf(it);
  const ps = paperSize(it, g.pt);
  const shownAngle = ((picAngle(it) + g.R) % 360 + 540) % 360 - 180;
  const r1 = (v) => String(Math.round(v * 10) / 10);
  const body = h(`<form class="pic-size" autocomplete="off">
    <div class="pic-size-row"><label class="field"><span>Width (mm)</span><input class="input" name="w" inputmode="decimal"></label>
      <label class="field"><span>Height (mm)</span><input class="input" name="h" inputmode="decimal"></label></div>
    <button type="button" role="switch" class="switch-row" data-keep><span class="grow">Keep its proportions</span><span class="switch on"></span></button>
    <label class="field"><span>Angle (degrees, clockwise)</span><input class="input" name="a" inputmode="decimal"></label>
    <div class="pic-size-row"><label class="field"><span>Slant across (°)</span><input class="input" name="sh" inputmode="decimal"></label>
      <label class="field"><span>Slant down (°)</span><input class="input" name="sv" inputmode="decimal"></label></div>
    <p class="note">Sizes are on the paper. Slants go from −75 to 75.</p>
    <p class="form-error" hidden></p></form>`);
  const f = body;
  f.w.value = r1(ps.w / MM);
  f.h.value = r1(ps.h / MM);
  f.a.value = r1(shownAngle);
  f.sh.value = r1(s.skew[0]);
  f.sv.value = r1(s.skew[1]);
  let keep = true;
  const kb = f.querySelector("[data-keep]");
  kb.addEventListener("click", () => { keep = !keep; kb.querySelector(".switch").classList.toggle("on", keep); kb.setAttribute("aria-checked", keep); });
  kb.setAttribute("aria-checked", "true");
  const num = (v) => parseFloat(String(v).replace(",", "."));
  const ratio = ps.h / ps.w;
  let edited = null;
  f.w.addEventListener("input", () => { edited = "w"; if (keep && num(f.w.value) > 0) f.h.value = r1(num(f.w.value) * ratio); });
  f.h.addEventListener("input", () => { edited = "h"; if (keep && num(f.h.value) > 0) f.w.value = r1(num(f.h.value) / ratio); });
  const foot = h(`<div class="foot-row"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn primary" data-ok>Apply</button></div>`);
  const sheet = openSheet({ title: "Exact size and angle", body, foot });
  foot.querySelector("[data-cancel]").addEventListener("click", () => sheet.close());
  const err = f.querySelector(".form-error");
  const submit = () => {
    const W = num(f.w.value), H = num(f.h.value), A = num(f.a.value), SH = num(f.sh.value), SV = num(f.sv.value);
    if (!(W > 0.5) || !(H > 0.5) || W > 5000 || H > 5000) { err.textContent = "Type a width and height in mm, like 50."; err.hidden = false; return; }
    if (!isFinite(A) || !isFinite(SH) || !isFinite(SV) || Math.abs(SH) > 75 || Math.abs(SV) > 75) { err.textContent = "Angles are numbers; slants go from −75 to 75."; err.hidden = false; return; }
    void edited;
    sheet.close();
    editPic(mk, (x) => {
      const p0 = paperSize(x, g.pt);
      let n = structuredClone(x);
      n.w = (W * MM) / p0.kx;
      n.h = (H * MM) / p0.ky;
      n.img = { ...n.img, skew: [SH, SV] };
      const nowShown = ((picAngle(n) + g.R) % 360 + 540) % 360 - 180;
      if (Math.abs(A - nowShown) > 0.01) n = turned(n, A - nowShown);
      return n;
    });
  };
  foot.querySelector("[data-ok]").addEventListener("click", submit);
  f.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
}

export { DEFAULTS };
