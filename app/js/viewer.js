// Continuous page viewer with pinch and double-tap zoom.
// Each page has a "base" picture sized for the current zoom (capped), and when you
// zoom past that cap a sharp "detail" picture is drawn just for the part on screen.
import { schedule, drawPage } from "./render.js";
import { renderOverlay, setLive } from "./overlay.js";
import { pageGeom, inv, apply, mul, rot, S } from "./geom.js";
import { pdfjsLib } from "./doc.js";

const BASE_MAX_PX = 4.5e6;
const DETAIL_MAX_PX = 10e6;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 24;
const GAP = 12;
const MARGIN = 10;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Viewer {
  constructor(root, wrap, badge, hooks = {}) {
    this.root = root;
    this.wrap = wrap;
    this.badge = badge;
    this.hooks = hooks;
    this.doc = null;
    this.items = [];
    this.zoom = 1;
    this.layerVer = 0;
    this.active = false;
    this.pinch = null;
    this.tap = null;
    this.lastTap = null;
    this.tapTimer = 0;
    this.raf = 0;
    this.idleTimer = 0;
    this.badgeTimer = 0;
    this.markup = false;
    this.selectedId = null;

    root.addEventListener("scroll", () => this.onScroll(), { passive: true });
    root.addEventListener("touchstart", (e) => this.onTouchStart(e), { passive: false });
    root.addEventListener("touchmove", (e) => this.onTouchMove(e), { passive: false });
    root.addEventListener("touchend", (e) => this.onTouchEnd(e), { passive: false });
    root.addEventListener("touchcancel", (e) => this.onTouchEnd(e), { passive: false });
    root.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    root.addEventListener("dblclick", (e) => { if (!("ontouchstart" in window) && !this.markup) this.toggleZoomAt(e.clientX, e.clientY); });
    this.ro = new ResizeObserver(() => { if (this.active) this.relayoutKeepingPlace(); });
    this.ro.observe(root);
    wrap.addEventListener("click", (e) => {
      const b = e.target.closest(".pin, .pin-area");
      if (!b) return;
      const pageEl = b.closest(".vpage");
      const it = this.items.find((x) => x.el === pageEl);
      if (it && this.hooks.onPin) this.hooks.onPin(it.p, b.dataset.id, b);
    });
  }

  /* ---------- document ---------- */

  setDoc(doc) {
    this.clear();
    this.doc = doc;
    this.zoom = 1;
    this.root.scrollTo(0, 0);
    this.build();
  }

  clear() {
    for (const it of this.items) this.dropItem(it);
    this.items = [];
    this.wrap.textContent = "";
    this.doc = null;
  }

  dropItem(it) {
    if (it.baseJob) it.baseJob.cancel();
    if (it.detailJob) it.detailJob.cancel();
    if (it.base) it.base.width = 0;
    if (it.detail) it.detail.canvas.width = 0;
    this.dropText(it);
    it.el.remove();
  }

  build() {
    const old = new Map(this.items.map((it) => [it.p.key, it]));
    const items = [];
    for (const p of this.doc.pages) {
      let it = old.get(p.key);
      if (it) {
        old.delete(p.key);
        const changed = it.p.rot !== p.rot || JSON.stringify(it.p.crop) !== JSON.stringify(p.crop) || it.fit !== this.fitOf(p);
        it.p = p;
        if (changed) { this.resetPicture(it); this.dropText(it); }
        it.ovVer = -1;
      } else {
        const el = document.createElement("div");
        el.className = "vpage";
        it = { p, el, base: null, baseScale: 0, baseVer: -1, baseJob: null, detail: null, detailJob: null };
        this.wrap.appendChild(el);
      }
      it.fit = this.fitOf(p);
      items.push(it);
    }
    for (const it of old.values()) this.dropItem(it);
    this.items = items;
    this.layout();
  }

  fitOf(p) {
    return this.doc.src(p).kind === "image" ? this.doc.imageFit : "";
  }

  resetPicture(it) {
    if (it.baseJob) { it.baseJob.cancel(); it.baseJob = null; }
    if (it.detailJob) { it.detailJob.cancel(); it.detailJob = null; }
    if (it.base) { it.base.width = 0; it.base.remove(); it.base = null; }
    if (it.detail) { it.detail.canvas.width = 0; it.detail.canvas.remove(); it.detail = null; }
    it.baseScale = 0;
  }

  refresh() {
    if (!this.doc) return;
    const anchor = this.active ? this.anchorAt(this.contentPoint(this.rootRect().left, this.rootRect().top)) : null;
    this.build();
    if (anchor) this.restoreAnchor(anchor, this.rootRect().left, this.rootRect().top);
    this.update(true);
  }

  layersChanged() {
    this.layerVer++;
    clearTimeout(this.layerTimer);
    this.layerTimer = setTimeout(() => this.update(true), 60);
  }

  // Marks, comments or the watermark changed: redraw the overlays.
  marksChanged() {
    if (!this.doc) return;
    this.doc.ovVersion = (this.doc.ovVersion || 0) + 1;
    this.update(false);
  }

  setMarkup(on) {
    this.markup = on;
    this.root.classList.toggle("markup", on);
    this.tap = null;
    this.lastTap = null;
    clearTimeout(this.tapTimer);
  }

  /* ---------- page coordinates ---------- */

  pageAt(clientX, clientY) {
    let best = null, bestD = Infinity;
    for (const it of this.items) {
      const r = it.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const dx = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
      const dy = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
      const d = dx + dy;
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  geom(it) {
    if (!it.g || it.gKey !== this.geomKey(it)) { it.g = pageGeom(this.doc, it.p); it.gKey = this.geomKey(it); }
    return it.g;
  }
  geomKey(it) {
    return `${it.p.rot}|${JSON.stringify(it.p.crop)}|${this.fitOf(it.p)}`;
  }

  toBase(it, clientX, clientY) {
    const g = this.geom(it);
    const r = it.el.getBoundingClientRect();
    const dx = ((clientX - r.left) / r.width) * g.dw;
    const dy = ((clientY - r.top) / r.height) * g.dh;
    return apply(inv(g.b2d), dx, dy);
  }

  toClient(it, bx, by) {
    const g = this.geom(it);
    const r = it.el.getBoundingClientRect();
    const d = apply(g.b2d, bx, by);
    return [r.left + (d[0] / g.dw) * r.width, r.top + (d[1] / g.dh) * r.height];
  }

  // Base units per screen pixel on this page.
  basePerPx(it) {
    const g = this.geom(it);
    const k = Math.sqrt(Math.abs(g.b2d[0] * g.b2d[3] - g.b2d[1] * g.b2d[2]));
    return g.dw / it.w / k;
  }

  itemFor(key) {
    return this.items.find((x) => x.p.key === key) || null;
  }

  setLive(key, svg) {
    const it = this.itemFor(key);
    if (it) setLive(this.doc, it, svg);
  }

  panBy(dx, dy) {
    this.root.scrollLeft += dx;
    this.root.scrollTop += dy;
  }

  /* ---------- text you can select ---------- */

  dropText(it) {
    if (it.text && it.text.wrapper) it.text.wrapper.remove();
    it.text = null;
    it.textPending = false;
  }

  async ensureText(it) {
    if (it.text || it.textPending || !this.doc) return;
    const doc = this.doc;
    const s = doc.src(it.p);
    const ocr = s.ocr && s.ocr[it.p.index];
    it.textPending = true;
    try {
      if (ocr && ocr.words.length) {
        const wrapper = document.createElement("div");
        wrapper.className = "tl-wrap ocr-layer";
        const ctx = (this.measureCtx ||= document.createElement("canvas").getContext("2d"));
        const frag = document.createDocumentFragment();
        for (const w of ocr.words) {
          const hgt = Math.max(1, w.y1 - w.y0);
          const fs = hgt * 0.92;
          ctx.font = `${100}px sans-serif`;
          const mw = ctx.measureText(w.t).width * fs / 100 || 1;
          const sp = document.createElement("span");
          sp.textContent = w.t + " ";
          sp.style.cssText = `left:${w.x0}px;top:${w.y0}px;font-size:${fs}px;transform:scaleX(${((w.x1 - w.x0) / mw).toFixed(4)})`;
          frag.appendChild(sp);
        }
        wrapper.appendChild(frag);
        it.text = { wrapper, kind: "ocr", R: ocr.R || 0 };
      } else if (s.kind === "pdf") {
        const page = await s.pdf.getPage(it.p.index + 1);
        const g = this.geom(it);
        const vp = page.getViewport({ scale: 1, rotation: g.R });
        const tc = await page.getTextContent();
        if (!tc.items.length || this.doc !== doc) { it.text = { empty: true }; return; }
        const wrapper = document.createElement("div");
        wrapper.className = "tl-wrap";
        const container = document.createElement("div");
        container.className = "textLayer";
        container.style.setProperty("--scale-round-x", "1px");
        container.style.setProperty("--scale-round-y", "1px");
        wrapper.appendChild(container);
        const tl = new pdfjsLib.TextLayer({ textContentSource: tc, container, viewport: vp });
        await tl.render();
        it.text = { wrapper, container, kind: "pdf", fw: vp.width, fh: vp.height };
      } else {
        it.text = { empty: true };
        return;
      }
      if (this.doc !== doc || !it.el.isConnected) return;
      const ref = it.ov ? it.ov.marks : null;
      it.el.insertBefore(it.text.wrapper, ref);
      this.layoutText(it);
    } catch (e) {
      it.text = { empty: true };
    } finally {
      it.textPending = false;
    }
  }

  layoutText(it) {
    const t = it.text;
    if (!t || !t.wrapper) return;
    const g = this.geom(it);
    const s = it.w / g.dw;
    if (t.kind === "ocr") {
      const m = mul(S(s), mul(g.b2d, inv(rot(t.R, g.W, g.H))));
      t.wrapper.style.transform = `matrix(${m.join(",")})`;
      return;
    }
    const c = g.crop;
    const R = rot(g.R, g.W, g.H);
    const a = apply(R, c.x0 * g.W, c.y0 * g.H), b = apply(R, c.x1 * g.W, c.y1 * g.H);
    const ox = Math.min(a[0], b[0]), oy = Math.min(a[1], b[1]);
    const st = t.wrapper.style;
    st.left = -ox * s + "px";
    st.top = -oy * s + "px";
    st.width = t.fw * s + "px";
    st.height = t.fh * s + "px";
    t.container.style.setProperty("--total-scale-factor", s);
  }

  show() {
    this.active = true;
    this.layout();
    this.update(true);
  }

  hide() {
    this.active = false;
  }

  /* ---------- layout ---------- */

  layout() {
    if (!this.doc) return;
    const vw = this.root.clientWidth;
    if (!vw) return;
    const fit = Math.max(80, vw - 2 * MARGIN);
    let y = MARGIN;
    let maxW = 0;
    for (const it of this.items) {
      const sz = this.doc.pageSize(it.p);
      it.ptW = sz.w;
      it.ptH = sz.h;
      it.w = fit * this.zoom;
      it.h = (it.w * sz.h) / sz.w;
      it.top = y;
      y += it.h + GAP;
      if (it.w > maxW) maxW = it.w;
    }
    const contentW = Math.max(vw, maxW + 2 * MARGIN);
    for (const it of this.items) {
      it.left = (contentW - it.w) / 2;
      const st = it.el.style;
      st.left = it.left + "px";
      st.top = it.top + "px";
      st.width = it.w + "px";
      st.height = it.h + "px";
      st.setProperty("--blur", Math.max(3, it.w * 0.012).toFixed(1) + "px");
      if (it.text) this.layoutText(it);
    }
    this.wrap.style.width = contentW + "px";
    this.wrap.style.height = Math.max(y - GAP + MARGIN, this.root.clientHeight) + "px";
    if (this.hooks.onLayout) this.hooks.onLayout();
  }

  rootRect() {
    return this.root.getBoundingClientRect();
  }

  contentPoint(cx, cy) {
    const r = this.rootRect();
    return { x: this.root.scrollLeft + (cx - r.left), y: this.root.scrollTop + (cy - r.top) };
  }

  anchorAt(pt) {
    if (!this.items.length) return null;
    let best = this.items[0];
    for (const it of this.items) {
      if (it.top <= pt.y) best = it; else break;
    }
    return { key: best.p.key, fx: (pt.x - best.left) / best.w, fy: (pt.y - best.top) / best.h };
  }

  restoreAnchor(anchor, cx, cy) {
    if (!anchor) return;
    const it = this.items.find((i) => i.p.key === anchor.key);
    if (!it) return;
    const r = this.rootRect();
    const ax = it.left + anchor.fx * it.w;
    const ay = it.top + anchor.fy * it.h;
    this.root.scrollLeft = ax - (cx - r.left);
    this.root.scrollTop = ay - (cy - r.top);
  }

  relayoutKeepingPlace() {
    if (!this.doc || !this.items.length) return;
    const r = this.rootRect();
    const anchor = this.anchorAt(this.contentPoint(r.left, r.top));
    this.layout();
    this.restoreAnchor(anchor, r.left, r.top);
    this.update(true);
  }

  setZoom(z, cx, cy) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const anchor = this.anchorAt(this.contentPoint(cx, cy));
    const ratio = z / this.zoom;
    this.zoom = z;
    this.layout();
    this.restoreAnchor(anchor, cx, cy);
    // Keep any sharp detail picture in place (scaled) until a new one is drawn.
    for (const it of this.items) {
      if (it.detail) {
        const st = it.detail.canvas.style;
        for (const k of ["left", "top", "width", "height"]) st[k] = parseFloat(st[k]) * ratio + "px";
        it.detail.zoom = -1;
      }
    }
    this.update(true);
  }

  toggleZoomAt(cx, cy) {
    this.setZoom(this.zoom < 1.8 ? 2.5 : 1, cx, cy);
  }

  scrollToPage(index) {
    const it = this.items[index];
    if (!it) return;
    this.root.scrollTop = it.top - MARGIN;
    this.update(true);
  }

  // The page taking up most of the screen (the earlier one on a tie).
  currentIndex() {
    const top = this.root.scrollTop;
    const bottom = top + this.root.clientHeight;
    let idx = 0;
    let best = -1;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.top > bottom) break;
      const seen = Math.min(bottom, it.top + it.h) - Math.max(top, it.top);
      if (seen > best + 1) { best = seen; idx = i; }
    }
    return idx;
  }

  /* ---------- rendering ---------- */

  onScroll() {
    if (!this.active) return;
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.update(false); });
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.update(true), 140);
    this.showBadge();
  }

  showBadge() {
    if (!this.items.length) return;
    this.badge.textContent = `${this.currentIndex() + 1} / ${this.items.length}`;
    this.badge.classList.add("show");
    clearTimeout(this.badgeTimer);
    this.badgeTimer = setTimeout(() => this.badge.classList.remove("show"), 1200);
  }

  update(idle) {
    if (!this.active || !this.doc || this.pinch) return;
    const top = this.root.scrollTop;
    const vh = this.root.clientHeight;
    const bottom = top + vh;
    for (const it of this.items) {
      const itBottom = it.top + it.h;
      const visible = itBottom > top && it.top < bottom;
      const near = itBottom > top - vh * 1.5 && it.top < bottom + vh * 1.5;
      const far = itBottom < top - vh * 4 || it.top > bottom + vh * 4;
      if (visible || near) {
        if (it.ovVer !== this.doc.ovVersion) renderOverlay(this.doc, it);
      }
      if (visible) {
        this.ensureBase(it, 9);
        if (idle) this.ensureDetail(it);
        if (idle && !this.markup) this.ensureText(it);
      } else if (near) {
        this.ensureBase(it, 3);
        this.dropDetail(it);
      } else {
        if (it.baseJob) { it.baseJob.cancel(); it.baseJob = null; }
        this.dropDetail(it);
        if (far && it.base) { it.base.width = 0; it.base.remove(); it.base = null; it.baseScale = 0; }
        if (far && it.text) this.dropText(it);
      }
    }
    this.hooks.onPage && this.hooks.onPage(this.currentIndex());
  }

  baseScaleFor(it) {
    const dpr = window.devicePixelRatio || 1;
    let s = (it.w * dpr) / it.ptW;
    const area = it.ptW * s * it.ptH * s;
    if (area > BASE_MAX_PX) s *= Math.sqrt(BASE_MAX_PX / area);
    return s;
  }

  ensureBase(it, pri) {
    const s = this.baseScaleFor(it);
    const ver = this.layerVer;
    if (it.baseJob && !it.baseJob.done) {
      if (it.baseJobVer === ver && Math.abs(it.baseJobScale - s) / s < 0.2) {
        it.baseJob.pri = pri;
        return;
      }
      it.baseJob.cancel();
    }
    if (it.base && it.baseVer === ver && Math.abs(it.baseScale - s) / s < 0.25) return;
    const canvas = document.createElement("canvas");
    canvas.className = "base";
    const region = { x: 0, y: 0, w: Math.round(it.ptW * s), h: Math.round(it.ptH * s) };
    const doc = this.doc;
    const job = schedule(pri, (j) => drawPage(doc, it.p, s, region, canvas, j));
    it.baseJob = job;
    it.baseJobScale = s;
    it.baseJobVer = ver;
    job.promise.then(() => {
      if (it.baseJob !== job || this.doc !== doc) { canvas.width = 0; return; }
      it.baseJob = null;
      if (it.base) { it.base.width = 0; it.base.replaceWith(canvas); } else it.el.prepend(canvas);
      it.base = canvas;
      it.baseScale = s;
      it.baseVer = ver;
    }, (e) => {
      if (it.baseJob === job) it.baseJob = null;
      if (!e || !e.cancelled) console.warn("Page drawing failed", e);
    });
  }

  dropDetail(it) {
    if (it.detailJob) { it.detailJob.cancel(); it.detailJob = null; }
    if (it.detail) { it.detail.canvas.width = 0; it.detail.canvas.remove(); it.detail = null; }
  }

  ensureDetail(it) {
    const dpr = window.devicePixelRatio || 1;
    const s = (it.w * dpr) / it.ptW;
    if (it.base && it.baseVer === this.layerVer && it.baseScale >= s * 0.95) { this.dropDetail(it); return; }
    const vw = this.root.clientWidth;
    const vh = this.root.clientHeight;
    const vx0 = this.root.scrollLeft - it.left;
    const vy0 = this.root.scrollTop - it.top;
    let x0 = Math.max(0, vx0);
    let y0 = Math.max(0, vy0);
    let x1 = Math.min(it.w, vx0 + vw);
    let y1 = Math.min(it.h, vy0 + vh);
    if (x1 <= x0 || y1 <= y0) { this.dropDetail(it); return; }
    const d = it.detail;
    if (d && d.zoom === this.zoom && d.ver === this.layerVer && d.x0 <= x0 + 0.5 && d.y0 <= y0 + 0.5 && d.x1 >= x1 - 0.5 && d.y1 >= y1 - 0.5) return;
    // Draw a little beyond the screen so small pans stay sharp.
    const mx = (x1 - x0) * 0.2;
    const my = (y1 - y0) * 0.2;
    const ex0 = Math.max(0, x0 - mx), ey0 = Math.max(0, y0 - my);
    const ex1 = Math.min(it.w, x1 + mx), ey1 = Math.min(it.h, y1 + my);
    if ((ex1 - ex0) * (ey1 - ey0) * dpr * dpr <= DETAIL_MAX_PX) { x0 = ex0; y0 = ey0; x1 = ex1; y1 = ey1; }
    let k = dpr;
    const area = (x1 - x0) * (y1 - y0) * k * k;
    if (area > DETAIL_MAX_PX) k *= Math.sqrt(DETAIL_MAX_PX / area);
    const scale = (it.w * k) / it.ptW;
    const region = {
      x: Math.floor(x0 * k),
      y: Math.floor(y0 * k),
      w: Math.ceil((x1 - x0) * k),
      h: Math.ceil((y1 - y0) * k)
    };
    if (it.detailJob) it.detailJob.cancel();
    const canvas = document.createElement("canvas");
    canvas.className = "detail";
    const doc = this.doc;
    const zoom = this.zoom;
    const ver = this.layerVer;
    const job = schedule(7, (j) => drawPage(doc, it.p, scale, region, canvas, j));
    it.detailJob = job;
    job.promise.then(() => {
      if (it.detailJob !== job || this.doc !== doc || this.zoom !== zoom) { canvas.width = 0; return; }
      it.detailJob = null;
      const st = canvas.style;
      st.left = region.x / k + "px";
      st.top = region.y / k + "px";
      st.width = region.w / k + "px";
      st.height = region.h / k + "px";
      if (it.detail) { it.detail.canvas.width = 0; it.detail.canvas.replaceWith(canvas); } else it.el.insertBefore(canvas, it.base ? it.base.nextSibling : it.el.firstChild);
      it.detail = { canvas, zoom, ver, x0: region.x / k, y0: region.y / k, x1: (region.x + region.w) / k, y1: (region.y + region.h) / k };
    }, (e) => {
      if (it.detailJob === job) it.detailJob = null;
      if (!e || !e.cancelled) console.warn("Detail drawing failed", e);
    });
  }

  /* ---------- gestures ---------- */

  onTouchStart(e) {
    if (e.touches.length === 2) {
      if (this.hooks.onPinchStart) this.hooks.onPinchStart();
      const [a, b] = e.touches;
      const m = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
      this.pinch = {
        d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
        m0: m,
        m,
        z0: this.zoom,
        s: 1,
        p: this.contentPoint(m.x, m.y),
        sl0: this.root.scrollLeft,
        st0: this.root.scrollTop
      };
      this.tap = null;
      clearTimeout(this.tapTimer);
      e.preventDefault();
    } else if (e.touches.length === 1 && !this.pinch && !this.markup) {
      const t = e.touches[0];
      this.tap = { x: t.clientX, y: t.clientY, t: performance.now(), moved: false };
    } else {
      this.tap = null;
    }
  }

  onTouchMove(e) {
    const pz = this.pinch;
    if (pz && e.touches.length >= 2) {
      if (e.cancelable) e.preventDefault();
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const m = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
      const z = clamp((pz.z0 * d) / pz.d0, MIN_ZOOM, MAX_ZOOM);
      pz.s = z / pz.z0;
      pz.m = m;
      const dsx = this.root.scrollLeft - pz.sl0;
      const dsy = this.root.scrollTop - pz.st0;
      const tx = pz.p.x * (1 - pz.s) + (m.x - pz.m0.x) + dsx;
      const ty = pz.p.y * (1 - pz.s) + (m.y - pz.m0.y) + dsy;
      this.wrap.style.transform = `translate(${tx}px, ${ty}px) scale(${pz.s})`;
      return;
    }
    if (this.tap && e.touches.length === 1) {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - this.tap.x, t.clientY - this.tap.y) > 10) this.tap.moved = true;
    }
  }

  onTouchEnd(e) {
    const pz = this.pinch;
    if (pz) {
      if (e.touches.length >= 2) return;
      e.preventDefault();
      this.pinch = null;
      this.tap = null;
      const anchor = this.anchorAt(pz.p);
      const ratio = pz.s;
      this.zoom = clamp(pz.z0 * pz.s, MIN_ZOOM, MAX_ZOOM);
      this.layout();
      this.restoreAnchor(anchor, pz.m.x, pz.m.y);
      this.wrap.style.transform = "";
      for (const it of this.items) {
        if (it.detail) {
          const st = it.detail.canvas.style;
          for (const k of ["left", "top", "width", "height"]) st[k] = parseFloat(st[k]) * ratio + "px";
          it.detail.zoom = -1;
        }
      }
      this.update(true);
      this.showBadge();
      return;
    }
    const tp = this.tap;
    this.tap = null;
    if (!tp || tp.moved || e.touches.length) return;
    const now = performance.now();
    if (now - tp.t > 350) return;
    const lt = this.lastTap;
    if (lt && now - lt.t < 320 && Math.hypot(tp.x - lt.x, tp.y - lt.y) < 40) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      e.preventDefault();
      this.toggleZoomAt(tp.x, tp.y);
      return;
    }
    this.lastTap = { x: tp.x, y: tp.y, t: now };
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => { this.lastTap = null; this.hooks.onTap && this.hooks.onTap(); }, 330);
  }

  onWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
  }
}
