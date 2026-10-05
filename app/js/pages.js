// Page grid: select, drag to reorder, thumbnails drawn on demand.
import { schedule, drawPage, renderKey } from "./render.js";
import { icon, esc, h } from "./ui.js";
import { baseName } from "./doc.js";

const LONG_PRESS_MS = 380;

function copyCanvas(c) {
  const n = document.createElement("canvas");
  n.width = c.width;
  n.height = c.height;
  n.style.cssText = c.style.cssText;
  n.getContext("2d").drawImage(c, 0, 0);
  return n;
}

export class PageGrid {
  constructor(scroller, grid, hooks = {}) {
    this.scroller = scroller;
    this.grid = grid;
    this.hooks = hooks;
    this.doc = null;
    this.tiles = new Map();
    this.thumbs = new Map();
    this.selection = new Set();
    this.drag = null;
    this.press = null;
    this.io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) this.drawThumb(en.target);
    }, { root: scroller, rootMargin: "400px 0px" });

    grid.addEventListener("pointerdown", (e) => this.onDown(e));
    window.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", (e) => this.onUp(e));
    window.addEventListener("pointercancel", (e) => this.onCancel(e));
    grid.addEventListener("touchmove", (e) => { if (this.drag) e.preventDefault(); }, { passive: false });
    grid.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  setDoc(doc) {
    this.clear();
    this.doc = doc;
    this.refresh();
  }

  clear() {
    this.io.disconnect();
    for (const t of this.tiles.values()) if (t.job) t.job.cancel();
    for (const c of this.thumbs.values()) c.width = 0;
    this.tiles.clear();
    this.thumbs.clear();
    this.selection.clear();
    this.grid.textContent = "";
    this.doc = null;
  }

  refresh() {
    if (!this.doc) return;
    const doc = this.doc;
    const multi = new Set(doc.pages.map((p) => p.src)).size > 1;
    const keep = new Set(doc.pages.map((p) => p.key));
    for (const k of [...this.selection]) if (!keep.has(k)) this.selection.delete(k);
    for (const [k, t] of this.tiles) {
      if (!keep.has(k)) { if (t.job) t.job.cancel(); this.io.unobserve(t.el); t.el.remove(); this.tiles.delete(k); }
    }
    const frag = document.createDocumentFragment();
    doc.pages.forEach((p, i) => {
      let t = this.tiles.get(p.key);
      if (!t) {
        const el = h(`<div class="tile" data-key="${p.key}">
          <div class="thumb"><div class="ph"></div><span class="check">${icon("check")}</span></div>
          <div class="cap"></div></div>`);
        t = { el, p, key: null, job: null };
        this.tiles.set(p.key, t);
      }
      t.p = p;
      const s = doc.src(p);
      t.el.querySelector(".cap").innerHTML = multi
        ? `<i style="background:${s.color}"></i><span>${i + 1} · ${esc(baseName(s.name))}</span>`
        : `<span>${i + 1}</span>`;
      t.el.classList.toggle("sel", this.selection.has(p.key));
      const want = renderKey(doc, p);
      if (t.key !== want) this.placeThumb(t, want);
      frag.appendChild(t.el);
    });
    this.grid.appendChild(frag);
    for (const t of this.tiles.values()) {
      // Re-observing makes the observer report tiles already on screen, so they redraw.
      if (!t.key) this.io.unobserve(t.el);
      this.io.observe(t.el);
    }
    this.trimThumbs();
    this.emitSelection();
  }

  trimThumbs() {
    if (this.thumbs.size <= 300) return;
    for (const [k, c] of this.thumbs) {
      if (this.thumbs.size <= 200) break;
      if (!c.isConnected) { c.width = 0; this.thumbs.delete(k); }
    }
  }

  placeThumb(t, key) {
    if (t.job) { t.job.cancel(); t.job = null; }
    const box = t.el.querySelector(".thumb");
    const cached = this.thumbs.get(key);
    const old = box.querySelector("canvas, .ph");
    if (cached) {
      // Duplicated pages look the same; each tile needs its own copy of the picture.
      const pic = cached.parentNode && !box.contains(cached) ? copyCanvas(cached) : cached;
      if (old) { if (old !== pic) old.replaceWith(pic); } else box.prepend(pic);
      t.key = key;
      return;
    }
    t.key = null;
    t.wantKey = key;
    if (old && old.tagName === "CANVAS") return; // keep the old picture until the new one is ready
  }

  drawThumb(tileEl) {
    const t = this.tiles.get(Number(tileEl.dataset.key));
    if (!t || t.key || t.job || !this.doc) return;
    const doc = this.doc;
    const box = tileEl.querySelector(".thumb");
    const bw = box.clientWidth;
    const bh = box.clientHeight;
    if (!bw || !bh) return;
    const sz = doc.pageSize(t.p);
    const k = Math.min(bw / sz.w, bh / sz.h);
    const cssW = Math.max(1, Math.round(sz.w * k));
    const cssH = Math.max(1, Math.round(sz.h * k));
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const scale = k * dpr;
    const canvas = document.createElement("canvas");
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const key = t.wantKey || renderKey(doc, t.p);
    const p = t.p;
    const job = schedule(1, (j) => drawPage(doc, p, scale, { x: 0, y: 0, w: cssW * dpr, h: cssH * dpr }, canvas, j));
    t.job = job;
    job.promise.then(() => {
      if (t.job !== job || this.doc !== doc) return;
      t.job = null;
      this.thumbs.set(key, canvas);
      if (renderKey(doc, t.p) !== key) return;
      const old = box.querySelector("canvas, .ph");
      if (old) { if (old !== canvas) old.replaceWith(canvas); } else box.prepend(canvas);
      t.key = key;
    }, (e) => {
      if (t.job === job) t.job = null;
      if (!e || !e.cancelled) console.warn("Thumbnail failed", e);
    });
  }

  layersChanged() {
    if (!this.doc) return;
    for (const t of this.tiles.values()) {
      const want = renderKey(this.doc, t.p);
      if (t.key !== want) this.placeThumb(t, want);
    }
    // Re-trigger drawing for tiles on screen.
    this.io.disconnect();
    for (const t of this.tiles.values()) this.io.observe(t.el);
  }

  /* ---------- selection ---------- */

  selectedPages() {
    return this.doc ? this.doc.pages.filter((p) => this.selection.has(p.key)) : [];
  }

  toggle(key) {
    if (this.selection.has(key)) this.selection.delete(key); else this.selection.add(key);
    const t = this.tiles.get(key);
    if (t) t.el.classList.toggle("sel", this.selection.has(key));
    this.emitSelection();
  }

  setAll(on) {
    this.selection.clear();
    if (on && this.doc) for (const p of this.doc.pages) this.selection.add(p.key);
    for (const [k, t] of this.tiles) t.el.classList.toggle("sel", this.selection.has(k));
    this.emitSelection();
  }

  emitSelection() {
    this.hooks.onSelection && this.hooks.onSelection(this.selection.size);
  }

  /* ---------- press, tap and drag ---------- */

  onDown(e) {
    if (e.button > 0 || this.drag) return;
    const tile = e.target.closest(".tile");
    if (!tile) return;
    const key = Number(tile.dataset.key);
    this.press = { id: e.pointerId, x: e.clientX, y: e.clientY, key, tile, moved: false, long: false };
    clearTimeout(this.pressTimer);
    this.pressTimer = setTimeout(() => {
      if (!this.press || this.press.moved) return;
      this.press.long = true;
      this.startDrag(this.press);
    }, LONG_PRESS_MS);
  }

  onMove(e) {
    const pr = this.press;
    if (!pr || e.pointerId !== pr.id) return;
    if (this.drag) {
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.moveGhost();
      return;
    }
    if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 8) {
      pr.moved = true;
      clearTimeout(this.pressTimer);
    }
  }

  onUp(e) {
    const pr = this.press;
    if (!pr || e.pointerId !== pr.id) return;
    clearTimeout(this.pressTimer);
    this.press = null;
    if (this.drag) { this.finishDrag(true); return; }
    if (!pr.moved && !pr.long) this.toggle(pr.key);
  }

  onCancel(e) {
    const pr = this.press;
    if (!pr || e.pointerId !== pr.id) return;
    clearTimeout(this.pressTimer);
    this.press = null;
    if (this.drag) this.finishDrag(false);
  }

  startDrag(pr) {
    const doc = this.doc;
    if (!doc) return;
    const moving = this.selection.has(pr.key) ? doc.pages.filter((p) => this.selection.has(p.key)).map((p) => p.key) : [pr.key];
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* ignore */ } }
    const ghost = h(`<div class="drag-ghost"></div>`);
    const src = pr.tile.querySelector(".thumb canvas");
    if (src) {
      const c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      c.getContext("2d").drawImage(src, 0, 0);
      ghost.appendChild(c);
    } else {
      ghost.style.height = "110px";
    }
    if (moving.length > 1) ghost.insertAdjacentHTML("beforeend", `<b>${moving.length}</b>`);
    document.body.appendChild(ghost);
    const mark = h(`<div class="drop-mark"></div>`);
    this.grid.appendChild(mark);
    for (const k of moving) { const t = this.tiles.get(k); if (t) t.el.classList.add("dragging"); }
    this.grid.style.position = "relative";
    this.drag = { moving, ghost, mark, x: pr.x, y: pr.y, drop: null };
    this.moveGhost();
    const loop = () => {
      if (!this.drag) return;
      const r = this.scroller.getBoundingClientRect();
      const edge = 70;
      let dy = 0;
      if (this.drag.y < r.top + edge) dy = -Math.ceil((r.top + edge - this.drag.y) / 6);
      else if (this.drag.y > r.bottom - edge) dy = Math.ceil((this.drag.y - (r.bottom - edge)) / 6);
      if (dy) { this.scroller.scrollTop += dy; this.computeDrop(); }
      this.drag.raf = requestAnimationFrame(loop);
    };
    this.drag.raf = requestAnimationFrame(loop);
  }

  moveGhost() {
    const d = this.drag;
    d.ghost.style.left = d.x + "px";
    d.ghost.style.top = d.y + "px";
    this.computeDrop();
  }

  computeDrop() {
    const d = this.drag;
    const tiles = [...this.grid.querySelectorAll(".tile")];
    if (!tiles.length) return;
    let best = null;
    let bestDist = Infinity;
    tiles.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dist = Math.hypot((d.x - cx) * 0.8, d.y - cy);
      if (dist < bestDist) { bestDist = dist; best = { el, i, r }; }
    });
    const before = d.x < best.r.left + best.r.width / 2;
    d.drop = best.i + (before ? 0 : 1);
    const gr = this.grid.getBoundingClientRect();
    const thumb = best.el.querySelector(".thumb").getBoundingClientRect();
    const x = before ? best.r.left - 6 : best.r.right + 4;
    d.mark.style.left = x - gr.left + "px";
    d.mark.style.top = thumb.top - gr.top + "px";
    d.mark.style.height = thumb.height + "px";
  }

  finishDrag(commit) {
    const d = this.drag;
    this.drag = null;
    cancelAnimationFrame(d.raf);
    d.ghost.remove();
    d.mark.remove();
    for (const t of this.tiles.values()) t.el.classList.remove("dragging");
    if (!commit || d.drop == null || !this.doc) return;
    const doc = this.doc;
    const moving = new Set(d.moving);
    const order = doc.pages;
    let insertAt = 0;
    for (let i = 0; i < d.drop && i < order.length; i++) if (!moving.has(order[i].key)) insertAt++;
    const rest = order.filter((p) => !moving.has(p.key));
    const moved = order.filter((p) => moving.has(p.key));
    const next = [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)];
    if (next.every((p, i) => p === order[i])) return;
    doc.commit();
    doc.pages = next;
    doc.changed({ reorder: true });
  }
}
