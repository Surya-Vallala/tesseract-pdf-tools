// Full-screen crop editor.
import { drawPage, schedule } from "./render.js";
import { icon, h, pushLayer, closeLayer, hydrateIcons } from "./ui.js";
import { displayToBase, baseToDisplay } from "./doc.js";

const MIN_PX = 28;

export function openCrop(doc, target, selected, onApply) {
  const multiSel = selected.length > 1;
  const total = doc.pages.length;
  const scr = h(`<div class="crop-screen" role="dialog" aria-label="Crop">
    <div class="crop-top">
      <button class="ib" type="button" data-x aria-label="Cancel">${icon("close")}</button>
      <h2>Crop</h2>
      <button class="btn" type="button" data-reset style="background:transparent;color:#f0efea;border-color:#3a3a37">Reset</button>
    </div>
    <div class="crop-stage"><div class="crop-paper"></div><div class="crop-clip"><div class="crop-box">
      <span class="e t" data-m="t"></span><span class="e b" data-m="b"></span><span class="e l" data-m="l"></span><span class="e r" data-m="r"></span>
      <span class="h tl" data-m="tl"></span><span class="h tr" data-m="tr"></span><span class="h bl" data-m="bl"></span><span class="h br" data-m="br"></span>
    </div></div></div>
    <div class="crop-foot">
      ${total > 1 ? `<div class="seg" role="radiogroup" aria-label="Apply to">
        <button type="button" data-scope="one">This page</button>
        ${multiSel ? `<button type="button" data-scope="sel">Selected (${selected.length})</button>` : ""}
        <button type="button" data-scope="all">All pages (${total})</button>
      </div>` : ""}
      <div class="row"><button class="btn primary" type="button" data-apply>Crop</button></div>
    </div>
  </div>`);
  document.body.appendChild(scr);
  hydrateIcons(scr);

  let scope = multiSel ? "sel" : "one";
  const segBtns = scr.querySelectorAll("[data-scope]");
  const paintScope = () => segBtns.forEach((b) => b.classList.toggle("on", b.dataset.scope === scope));
  segBtns.forEach((b) => b.addEventListener("click", () => { scope = b.dataset.scope; paintScope(); }));
  paintScope();

  const stage = scr.querySelector(".crop-stage");
  const paper = scr.querySelector(".crop-paper");
  const clip = scr.querySelector(".crop-clip");
  const box = scr.querySelector(".crop-box");
  const { R } = doc.base(target);
  const full = { ...target, crop: null };
  let geo = null; // paper rect in stage px
  let rect = null; // crop rect in paper px
  let job = null;

  function layout() {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const pad = 28;
    const cs = doc.contentSize(full);
    const k = Math.min((sw - pad * 2) / cs.w, (sh - pad * 2) / cs.h);
    const w = cs.w * k;
    const hgt = cs.h * k;
    const prev = geo;
    geo = { x: (sw - w) / 2, y: (sh - hgt) / 2, w, h: hgt, k };
    for (const el of [paper, clip]) Object.assign(el.style, { left: geo.x + "px", top: geo.y + "px", width: w + "px", height: hgt + "px" });
    if (!rect) {
      const c = target.crop;
      if (c) {
        const a = baseToDisplay(c.x0, c.y0, R);
        const b = baseToDisplay(c.x1, c.y1, R);
        rect = { x0: Math.min(a[0], b[0]) * w, y0: Math.min(a[1], b[1]) * hgt, x1: Math.max(a[0], b[0]) * w, y1: Math.max(a[1], b[1]) * hgt };
      } else rect = { x0: 0, y0: 0, x1: w, y1: hgt };
    } else if (prev) {
      const sx = w / prev.w, sy = hgt / prev.h;
      rect = { x0: rect.x0 * sx, y0: rect.y0 * sy, x1: rect.x1 * sx, y1: rect.y1 * sy };
    }
    paintBox();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    let scale = k * dpr;
    const area = cs.w * scale * cs.h * scale;
    if (area > 8e6) scale *= Math.sqrt(8e6 / area);
    const canvas = document.createElement("canvas");
    if (job) job.cancel();
    job = schedule(10, (j) => drawPage(doc, full, scale, { x: 0, y: 0, w: cs.w * scale, h: cs.h * scale }, canvas, j, { contentOnly: true }));
    job.promise.then(() => { paper.textContent = ""; paper.appendChild(canvas); }, () => {});
  }

  function paintBox() {
    Object.assign(box.style, { left: rect.x0 + "px", top: rect.y0 + "px", width: rect.x1 - rect.x0 + "px", height: rect.y1 - rect.y0 + "px" });
  }

  // Dragging: edges, corners, or the whole box.
  let drag = null;
  stage.addEventListener("pointerdown", (e) => {
    const m = e.target.dataset && e.target.dataset.m;
    const inside = e.target === box;
    if (!m && !inside) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, mode: m || "move", x: e.clientX, y: e.clientY, r: { ...rect } };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const r = { ...drag.r };
    const W = geo.w, H = geo.h;
    if (drag.mode === "move") {
      const bw = r.x1 - r.x0, bh = r.y1 - r.y0;
      r.x0 = Math.min(Math.max(0, r.x0 + dx), W - bw); r.x1 = r.x0 + bw;
      r.y0 = Math.min(Math.max(0, r.y0 + dy), H - bh); r.y1 = r.y0 + bh;
    } else {
      if (drag.mode.includes("l")) r.x0 = Math.min(Math.max(0, r.x0 + dx), r.x1 - MIN_PX);
      if (drag.mode.includes("r")) r.x1 = Math.max(Math.min(W, r.x1 + dx), r.x0 + MIN_PX);
      if (drag.mode.includes("t")) r.y0 = Math.min(Math.max(0, r.y0 + dy), r.y1 - MIN_PX);
      if (drag.mode.includes("b")) r.y1 = Math.max(Math.min(H, r.y1 + dy), r.y0 + MIN_PX);
    }
    rect = r;
    paintBox();
  });
  const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);

  const layer = pushLayer({ onClose: () => { if (job) job.cancel(); ro.disconnect(); scr.remove(); } });
  const ro = new ResizeObserver(() => layout());
  ro.observe(stage);

  scr.querySelector("[data-x]").addEventListener("click", () => closeLayer(layer));
  scr.querySelector("[data-reset]").addEventListener("click", () => { rect = { x0: 0, y0: 0, x1: geo.w, y1: geo.h }; paintBox(); });
  scr.querySelector("[data-apply]").addEventListener("click", () => {
    const u0 = rect.x0 / geo.w, v0 = rect.y0 / geo.h, u1 = rect.x1 / geo.w, v1 = rect.y1 / geo.h;
    const pages = scope === "all" ? doc.pages : scope === "sel" ? selected : [target];
    closeLayer(layer);
    onApply(pages, (p) => {
      const { R: pr } = doc.base(p);
      const a = displayToBase(u0, v0, pr);
      const b = displayToBase(u1, v1, pr);
      const c = { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
      const e = 0.002;
      if (c.x0 < e && c.y0 < e && c.x1 > 1 - e && c.y1 > 1 - e) return null;
      return c;
    });
  });
}
