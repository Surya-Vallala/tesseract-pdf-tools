// Mark up mode: pen, eraser, blur, shapes, select and comments.
// One finger draws and two fingers scroll and zoom; once an S Pen is used, the pen
// draws and a finger scrolls.
import { newId } from "./doc.js";
import { apply, inv, bbox, distToPolyline, distToSeg } from "./geom.js";
import {
  PEN_KIND, PEN_COLORS, HIGHLIGHT_COLORS, COMMENT_COLORS, SHAPE_NAMES, thickFactor, levelOf, levelForWidth, levelPx,
  inkDrawable, shapeDrawable, commentDrawable, drawableToSVG, drawableFor, itemBounds,
  smoothPoints, thinPoints, blockMatrix
} from "./shapes.js";
import { icon, esc, h, segmented, openSheet, promptDialog, openMenu, toast, pushLayer, closeLayer } from "./ui.js";
import { settings } from "./platform.js";
import { recognizeShape } from "./snap.js";
import { sizeText, parseLen, INCH } from "./blocks.js";
import {
  blockPicker, rememberBlock, findScale, openScaleSheet, sizeChoices, parseSizeText, familyOf, ratioForK, getUnits, setUnits
} from "./blockui.js";

const DRAW_TOOLS = new Set(["pen", "eraser", "blur", "shapes", "comment"]);
const POINT_SHAPES = new Set(["arrow", "curved", "north", "section", "level", "line"]);
const CLOSED_SHAPES = new Set(["rect", "circle", "polygon", "star", "poly"]);
const HOLD_MS = 520;
const isBlock = (it) => it && it.kind === "shape" && it.shape === "block";

export class Markup {
  constructor({ viewer, screen, optbar, toolbar, chip, views, getDoc, onChange, onComment, askAuthor }) {
    this.viewer = viewer;
    this.screen = screen;
    this.optbar = optbar;
    this.toolbar = toolbar;
    this.chip = chip;
    this.views = views;
    this.getDoc = getDoc;
    this.onChange = onChange;
    this.onComment = onComment;
    this.askAuthor = askAuthor;
    this.active = false;
    this.tool = "pen";
    this.pen = settings.get("pen", { type: "pen", color: PEN_COLORS[0], hcolor: HIGHLIGHT_COLORS[0], thick: "medium", smooth: true, straightOnly: false });
    if (this.pen.snap == null) this.pen.snap = true;
    delete this.pen.straighten;
    this.block = settings.get("block", { color: "#1565C0", thick: "fine", fill: false });
    this.eraser = settings.get("eraser", { size: 28, mode: "whole" });
    this.shape = settings.get("shape", { shape: "rect", color: "#1565C0", thick: "medium", fill: false, sides: 6 });
    this.comment = settings.get("comment", { ctype: "box", color: COMMENT_COLORS[0], cloud: true });
    this.penSeen = false;
    this.sel = null; // { key, id }
    this.g = null;   // current gesture
    this.touches = new Set();
    this.selUI = null;

    const root = viewer.root;
    root.addEventListener("pointerdown", (e) => this.down(e));
    root.addEventListener("pointermove", (e) => this.move(e));
    root.addEventListener("pointerup", (e) => this.up(e));
    root.addEventListener("pointercancel", (e) => this.up(e, true));
    root.addEventListener("contextmenu", (e) => { if (this.active) e.preventDefault(); });
    toolbar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-tool]");
      if (b) this.setTool(b.dataset.tool, { fromBar: true });
    });
    viewer.hooks.onPinchStart = () => this.cancelGesture();
    viewer.hooks.onLayout = () => this.drawSelection();
  }

  get doc() { return this.getDoc(); }

  enter() {
    this.active = true;
    document.body.classList.add("markup-mode");
    this.viewer.setMarkup(true);
    this.paintTools();
    this.renderOptions();
    this.updateChip();
    if (!settings.get("hint-draw-seen", false)) this.showHint();
  }

  exit() {
    this.cancelGesture();
    this.select(null);
    this.closeComposer();
    this.hideHint();
    this.active = false;
    document.body.classList.remove("markup-mode");
    this.viewer.setMarkup(false);
  }

  showHint() {
    if (this.hint) return;
    const el = h(`<div class="draw-hint" role="status"><span>One finger draws. Two fingers scroll and zoom. With the S Pen, the pen draws and your finger scrolls.</span><button type="button">Got it</button></div>`);
    el.querySelector("button").addEventListener("click", () => { settings.set("hint-draw-seen", true); this.hideHint(); });
    this.views.appendChild(el);
    this.hint = el;
  }
  hideHint() {
    if (this.hint) this.hint.remove();
    this.hint = null;
  }

  /* ---------- tools and options ---------- */

  setTool(tool, { fromBar = false } = {}) {
    if (tool === "shapes" && fromBar) {
      this.openShapes();
      return;
    }
    if (this.tool !== tool && tool !== "select" && !(tool === "shapes" && this.sel)) this.select(null);
    this.tool = tool;
    this.paintTools();
    this.renderOptions();
    this.updateChip();
  }

  paintTools() {
    this.toolbar.querySelectorAll("[data-tool]").forEach((b) => {
      const on = b.dataset.tool === this.tool;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  updateChip() {
    const doc = this.doc;
    if (!doc) return;
    const l = doc.layer(doc.activeLayer);
    const isComment = this.tool === "comment" || this.tool === "blur";
    this.chip.innerHTML = isComment
      ? `<span class="chip-note">${this.tool === "comment" ? "Comments sit above all layers" : "Blur covers every layer"}</span>`
      : `<span class="chip-text">Drawing on <b>${esc(l ? l.name : "a new layer")}</b></span>${icon("chevdown")}`;
    this.chip.classList.toggle("note", isComment);
    this.chip.disabled = isComment;
  }

  styleButton(color, w, onClick, label) {
    const b = h(`<button type="button" class="style-btn" aria-label="${esc(label)}"><span class="dot" style="background:${color}"></span><span class="bar" style="height:${w}px"></span></button>`);
    b.addEventListener("click", onClick);
    return b;
  }

  renderOptions() {
    const o = this.optbar;
    o.textContent = "";
    const doc = this.doc;
    const selItem = this.selectedItem();
    const tool = this.tool;
    if (tool === "pen") {
      o.appendChild(segmented([
        { value: "pen", label: "Pen" }, { value: "marker", label: "Marker" }, { value: "highlighter", label: "Highlighter" }
      ], this.pen.type, (v) => { this.pen.type = v; this.savePrefs(); this.renderOptions(); }, { label: "Pen type" }));
      o.appendChild(h(`<span class="grow"></span>`));
      const col = this.pen.type === "highlighter" ? this.pen.hcolor : this.pen.color;
      o.appendChild(this.styleButton(col, levelPx(this.pen.thick), (e) => this.openPenStyle(e.currentTarget), "Pen colour and thickness"));
    } else if (tool === "eraser") {
      const seg = segmented([{ value: "whole", label: "Whole marks" }, { value: "part", label: "Part of a line" }], this.eraser.mode,
        (v) => { this.eraser.mode = v; this.savePrefs(); }, { label: "Eraser mode" });
      seg.classList.add("tight");
      o.appendChild(seg);
      const sz = h(`<label class="eraser-size"><span class="ring" aria-hidden="true"></span><input type="range" min="10" max="80" step="2" aria-label="Eraser size"></label>`);
      const ring = sz.querySelector(".ring"), rng = sz.querySelector("input");
      rng.value = this.eraser.size;
      const paint = () => { const d = Math.min(30, Math.max(8, this.eraser.size * 0.42)); ring.style.width = ring.style.height = d + "px"; };
      paint();
      rng.addEventListener("input", () => { this.eraser.size = Number(rng.value); paint(); });
      rng.addEventListener("change", () => this.savePrefs());
      o.appendChild(sz);
    } else if (tool === "blur") {
      o.appendChild(h(`<p class="opt-note">Drag over anything to hide it. It's blurred for good when you save.</p>`));
    } else if (tool === "shapes") {
      const b = h(`<button type="button" class="chip-btn">${icon(this.shape.shape)}<span>${esc(SHAPE_NAMES[this.shape.shape])}</span>${icon("chevdown")}</button>`);
      b.addEventListener("click", () => this.openShapes());
      o.appendChild(b);
      this.appendShapeStyle(o, this.shape, (patch) => { Object.assign(this.shape, patch); this.savePrefs(); this.renderOptions(); });
    } else if (tool === "comment") {
      const cseg = segmented([
        { value: "box", label: "Box" }, { value: "free", label: "Freehand" }, { value: "leader", label: "Leader" }
      ], this.comment.ctype, (v) => { this.comment.ctype = v; this.savePrefs(); this.renderOptions(); }, { label: "Comment type" });
      cseg.classList.add("tight");
      o.appendChild(cseg);
      const sw = h(`<div class="swatches small" role="radiogroup" aria-label="Comment colour"></div>`);
      COMMENT_COLORS.forEach((c) => {
        const b = h(`<button type="button" role="radio" aria-checked="${c === this.comment.color}" class="sw${c === this.comment.color ? " on" : ""}" style="--c:${c}" aria-label="Colour"></button>`);
        b.addEventListener("click", () => { this.comment.color = c; this.savePrefs(); this.renderOptions(); });
        sw.appendChild(b);
      });
      o.appendChild(sw);
      if (this.comment.ctype !== "leader") {
        const cl = h(`<button type="button" role="switch" aria-checked="${this.comment.cloud}" class="chip-btn toggle tight${this.comment.cloud ? " on" : ""}"><span>Cloud</span></button>`);
        cl.addEventListener("click", () => { this.comment.cloud = !this.comment.cloud; this.savePrefs(); this.renderOptions(); });
        o.appendChild(cl);
      }
    } else if (tool === "select") {
      if (!selItem) {
        o.appendChild(h(`<p class="opt-note">Tap a mark to select it. Drag empty space to move around.</p>`));
      } else if (isBlock(selItem)) {
        this.appendBlockOptions(o, selItem);
      } else if (selItem.kind === "ink" || selItem.kind === "shape") {
        if (selItem.kind === "ink") {
          const pal = selItem.pen === "highlighter" ? HIGHLIGHT_COLORS : PEN_COLORS;
          const thick = this.thickOf(selItem);
          o.appendChild(this.styleButton(selItem.color, levelPx(thick), (e) => this.openStylePicker(e.currentTarget, {
            colors: pal, color: selItem.color, thick, mult: (PEN_KIND[selItem.pen] || PEN_KIND.pen).mult,
            onChange: ({ color, thick: t }) => this.editSelected((it) => {
              if (color) it.color = color;
              if (t) it.w = thickFactor(t) * this.unitFor(this.sel.key) * (PEN_KIND[it.pen] || PEN_KIND.pen).mult;
            })
          }), "Colour and thickness"));
        } else {
          this.appendShapeStyle(o, { color: selItem.color, thick: this.thickOf(selItem), fill: selItem.fill, shape: selItem.shape, sides: selItem.sides }, (patch) => this.editSelected((it) => {
            if (patch.color) it.color = patch.color;
            if (patch.thick) it.w = thickFactor(patch.thick) * this.unitFor(this.sel.key);
            if (patch.fill != null) it.fill = patch.fill;
            if (patch.sides) it.sides = patch.sides;
          }));
        }
        const l = doc.layer(selItem.layer);
        const lb = h(`<button type="button" class="chip-btn grow-btn">${icon("layers")}<span class="ell">${esc(l ? l.name : "Layer")}</span>${icon("chevdown")}</button>`);
        lb.addEventListener("click", async () => {
          const v = await openMenu(lb, doc.layers.map((x) => ({ label: x.name, value: x.id, checked: x.id === selItem.layer })), { above: true, align: "start" });
          if (v) this.editSelected((it) => { it.layer = v; });
        });
        o.appendChild(lb);
      } else if (selItem.kind === "comment") {
        const sw = h(`<div class="swatches small" role="radiogroup" aria-label="Comment colour"></div>`);
        COMMENT_COLORS.forEach((c) => {
          const b = h(`<button type="button" role="radio" aria-checked="${c === selItem.color}" class="sw${c === selItem.color ? " on" : ""}" style="--c:${c}" aria-label="Colour"></button>`);
          b.addEventListener("click", () => this.editSelected((it) => { it.color = c; }));
          sw.appendChild(b);
        });
        o.appendChild(sw);
        if (selItem.ctype !== "leader") {
          const cl = h(`<button type="button" role="switch" aria-checked="${!!selItem.cloud}" class="chip-btn toggle${selItem.cloud ? " on" : ""}">${selItem.cloud ? icon("check") : ""}<span>Cloud</span></button>`);
          cl.addEventListener("click", () => this.editSelected((it) => { it.cloud = !it.cloud; }));
          o.appendChild(cl);
        }
      } else {
        o.appendChild(h(`<p class="opt-note">Blurred area. Drag to move it, or drag a corner to resize.</p>`));
      }
    }
  }

  appendShapeStyle(o, st, onPatch) {
    o.appendChild(this.styleButton(st.color, levelPx(st.thick), (e) => this.openStylePicker(e.currentTarget, {
      colors: PEN_COLORS, color: st.color, thick: st.thick,
      onChange: (p) => onPatch(p)
    }), "Colour and thickness"));
    if (CLOSED_SHAPES.has(st.shape)) {
      const f = h(`<button type="button" role="switch" aria-checked="${!!st.fill}" class="chip-btn toggle${st.fill ? " on" : ""}"><span class="fill-box"></span><span>Fill</span></button>`);
      f.addEventListener("click", () => onPatch({ fill: !st.fill }));
      o.appendChild(f);
    }
    if (st.shape === "polygon") {
      const s = h(`<div class="stepper" aria-label="Number of sides"><button type="button" aria-label="Fewer sides">−</button><span>${st.sides || 6} sides</span><button type="button" aria-label="More sides">+</button></div>`);
      const [minus, plus] = s.querySelectorAll("button");
      minus.addEventListener("click", () => onPatch({ sides: Math.max(3, (st.sides || 6) - 1) }));
      plus.addEventListener("click", () => onPatch({ sides: Math.min(12, (st.sides || 6) + 1) }));
      o.appendChild(s);
    }
  }

  thickOf(it) {
    const unit = this.unitFor(this.sel ? this.sel.key : null);
    const mult = it.kind === "ink" ? (PEN_KIND[it.pen] || PEN_KIND.pen).mult : 1;
    return levelForWidth(it.w, unit, mult);
  }

  unitFor(key) {
    const it = key != null ? this.viewer.itemFor(key) : null;
    return it ? this.viewer.geom(it).unit : 1000;
  }

  savePrefs() {
    settings.set("pen", this.pen);
    settings.set("shape", this.shape);
    settings.set("comment", this.comment);
    settings.set("block", this.block);
    settings.set("eraser", this.eraser);
  }

  openPenStyle(anchor) {
    const hl = this.pen.type === "highlighter";
    this.openStylePicker(anchor, {
      colors: hl ? HIGHLIGHT_COLORS : PEN_COLORS,
      color: hl ? this.pen.hcolor : this.pen.color,
      thick: this.pen.thick,
      mult: (PEN_KIND[this.pen.type] || PEN_KIND.pen).mult,
      toggles: [
        { key: "smooth", label: "Smooth strokes", on: this.pen.smooth },
        { key: "snap", label: "Hold still at the end to make a clean shape", on: this.pen.snap !== false },
        { key: "straightOnly", label: "Straight lines only", on: this.pen.straightOnly }
      ],
      onChange: (p) => {
        if (p.color) { if (hl) this.pen.hcolor = p.color; else this.pen.color = p.color; }
        if (p.thick) this.pen.thick = p.thick;
        if (p.toggle) this.pen[p.toggle.key] = p.toggle.on;
        this.savePrefs();
        this.renderOptions();
      }
    });
  }

  openStylePicker(anchor, { colors, color, thick, mult = 1, toggles = [], onChange }) {
    if (this.pop) this.pop.close();
    let level = levelOf(thick);
    let col = color;
    const pop = h(`<div class="pop" role="dialog" aria-label="Colour and thickness">
      <div class="pop-label">Colour</div><div class="swatches" role="radiogroup" aria-label="Colour"></div>
      <div class="pop-label thick-head"><span>Thickness</span><b class="thick-val"></b></div>
      <div class="thick-slider"><svg class="thick-preview" viewBox="0 0 240 32" preserveAspectRatio="none" aria-hidden="true"><path d="M8 20 C 60 4, 110 30, 160 14 S 220 10, 232 16" fill="none" stroke-linecap="round"/></svg>
        <input type="range" min="1" max="10" step="1" aria-label="Thickness"></div>
      <p class="pop-note">Thickness follows the sheet size, so lines look the same on A1 and A4.</p>
      <div class="pop-toggles"></div></div>`);
    const sw = pop.querySelector(".swatches");
    colors.forEach((c) => {
      const b = h(`<button type="button" role="radio" class="sw big${c === color ? " on" : ""}" style="--c:${c}" aria-checked="${c === color}" aria-label="Colour ${c}"></button>`);
      b.addEventListener("click", () => {
        sw.querySelectorAll(".sw").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); });
        col = c;
        paintThick();
        onChange({ color: c });
      });
      sw.appendChild(b);
    });
    const range = pop.querySelector(".thick-slider input");
    const prev = pop.querySelector(".thick-preview path");
    const val = pop.querySelector(".thick-val");
    range.value = level;
    const paintThick = () => {
      prev.setAttribute("stroke", col);
      prev.setAttribute("stroke-width", Math.min(26, levelPx(level) * 1.25 * Math.min(mult, 3.2)));
      prev.setAttribute("stroke-opacity", mult > 5 ? 0.45 : 1);
      val.textContent = `${level} of 10`;
    };
    paintThick();
    range.addEventListener("input", () => { level = Number(range.value); paintThick(); });
    range.addEventListener("change", () => { level = Number(range.value); paintThick(); onChange({ thick: level }); });
    const tg = pop.querySelector(".pop-toggles");
    for (const t of toggles) {
      const b = h(`<button type="button" role="switch" class="pop-toggle" aria-checked="${t.on}"><span>${esc(t.label)}</span><span class="switch${t.on ? " on" : ""}"></span></button>`);
      b.addEventListener("click", () => {
        t.on = !t.on;
        b.setAttribute("aria-checked", t.on);
        b.querySelector(".switch").classList.toggle("on", t.on);
        onChange({ toggle: { key: t.key, on: t.on } });
      });
      tg.appendChild(b);
    }
    if (!toggles.length) tg.remove();
    const scrim = h(`<div class="pop-scrim"></div>`);
    this.screen.append(scrim, pop);
    const close = () => { pop.remove(); scrim.remove(); if (this.pop && this.pop.el === pop) this.pop = null; };
    scrim.addEventListener("click", close);
    this.pop = { el: pop, close };
  }

  openShapes() {
    const groups = [
      ["Arrows", ["arrow", "curved"]],
      ["Shapes", ["rect", "circle", "polygon", "star"]],
      ["Drawing symbols", ["north", "section", "level"]]
    ];
    const body = h(`<div class="shapes-body"><div data-tabs></div><div data-pane></div></div>`);
    const pane = body.querySelector("[data-pane]");
    const footBox = h(`<div class="shapes-foot"></div>`);
    let sheet;
    let tab = settings.get("shapes-tab", "shapes");
    const showShapes = () => {
      pane.textContent = "";
      footBox.textContent = "";
      for (const [title, list] of groups) {
        pane.appendChild(h(`<div class="group-label">${esc(title)}</div>`));
        const grid = h(`<div class="shape-grid"></div>`);
        for (const sh of list) {
          const b = h(`<button type="button" class="shape-tile${sh === this.shape.shape && this.tool === "shapes" ? " on" : ""}">${icon(sh)}<span>${esc(SHAPE_NAMES[sh])}</span></button>`);
          b.addEventListener("click", () => {
            this.shape.shape = sh;
            this.savePrefs();
            sheet.close();
            this.setTool("shapes");
          });
          grid.appendChild(b);
        }
        pane.appendChild(grid);
      }
      pane.appendChild(h(`<p class="note" style="margin-top:16px">Pick a shape, then drag on the page. Later, tap it with Select to move it, resize it or type text inside. With the pen, hold still at the end of a stroke to turn it into a clean shape.</p>`));
    };
    const showBlocks = () => {
      pane.textContent = "";
      footBox.textContent = "";
      const vit = this.centerPage();
      const k = vit && vit.p.blockK;
      const photo = vit && this.doc.src(vit.p).kind === "image";
      const note = k ? `Real size at <b>${photo ? "your measured scale" : "1:" + ratioForK(k)}</b>.` : "Real size. You'll set the scale once.";
      const picker = blockPicker({
        scaleNote: note,
        onPick: (tile) => { sheet.close(); this.placeBlock(tile); },
        onChangeScale: () => { sheet.close(); if (vit) this.changeScale(vit); }
      });
      pane.appendChild(picker.el);
      footBox.appendChild(picker.foot);
    };
    const tabs = segmented([{ value: "shapes", label: "Shapes" }, { value: "blocks", label: "Architecture" }], tab, (v) => {
      tab = v;
      settings.set("shapes-tab", v);
      (v === "blocks" ? showBlocks : showShapes)();
    }, { label: "Shape library" });
    tabs.classList.add("shape-tabs");
    body.querySelector("[data-tabs]").appendChild(tabs);
    (tab === "blocks" ? showBlocks : showShapes)();
    sheet = openSheet({ title: "Shapes", body, foot: footBox, tall: true });
    sheet.sheet.classList.add("shapes-sheet");
  }

  /* ---------- architecture blocks ---------- */

  centerPage() {
    const r = this.viewer.root.getBoundingClientRect();
    return this.viewer.pageAt(r.left + r.width / 2, r.top + r.height / 2);
  }

  async ensureScale(vit) {
    const p = vit.p;
    if (p.blockK) return p.blockK;
    const photo = this.doc.src(p).kind === "image";
    const suggested = photo ? null : await findScale(this.doc, p);
    const res = await openScaleSheet({ photo, suggested, firstTime: true });
    if (!res) return null;
    let k = res.k;
    if (res.measure) k = await this.measure(vit);
    if (!k) return null;
    for (const q of this.doc.pages) if (q.src === p.src && !q.blockK) q.blockK = k;
    p.blockK = k;
    return k;
  }

  async changeScale(vit) {
    const p = vit.p;
    const doc = this.doc;
    const photo = doc.src(p).kind === "image";
    const oldK = p.blockK || null;
    const res = await openScaleSheet({ photo, suggested: oldK ? null : await findScale(doc, p), current: oldK && !photo ? ratioForK(oldK) : null, firstTime: !oldK });
    if (!res) return;
    let k = res.k;
    if (res.measure) k = await this.measure(vit);
    if (!k) return;
    doc.commit();
    let moved = 0;
    for (const q of doc.pages) {
      if (q !== p && !(q.src === p.src && (q.blockK === oldK || !q.blockK))) continue;
      q.blockK = k;
      for (const it of q.items) if (isBlock(it) && (!oldK || Math.abs(it.k - oldK) < 1e-9)) { it.k = k; moved++; }
    }
    this.changed();
    this.renderOptions();
    toast(moved ? `Scale set. ${moved} block${moved === 1 ? "" : "s"} resized to match.` : "Scale set.");
  }

  async placeBlock(tile) {
    const vit = this.centerPage();
    if (!vit) return;
    const k = await this.ensureScale(vit);
    if (!k) return;
    const doc = this.doc;
    const g = this.viewer.geom(vit);
    const r = this.viewer.root.getBoundingClientRect();
    let [cx, cy] = this.viewer.toBase(vit, r.left + r.width / 2, r.top + r.height * 0.42);
    const c = g.crop;
    cx = Math.max(c.x0 * g.W, Math.min(c.x1 * g.W, cx));
    cy = Math.max(c.y0 * g.H, Math.min(c.y1 * g.H, cy));
    const layer = doc.ensureLayer();
    doc.commit();
    const it = {
      id: newId(), kind: "shape", shape: "block", family: tile.family, name: tile.name, bw: tile.w, bd: tile.d, p: tile.p ? structuredClone(tile.p) : null,
      x1: cx, y1: cy, x2: cx, y2: cy, rot: (360 - g.R) % 360, flip: false, k,
      color: this.block.color, w: thickFactor(this.block.thick) * g.unit, fill: !!this.block.fill, text: "", layer: layer.id
    };
    vit.p.items.push(it);
    rememberBlock(tile);
    this.tool = "select";
    this.paintTools();
    this.sel = { key: vit.p.key, id: it.id };
    this.updateChip();
    this.changed();
    this.renderOptions();
  }

  appendBlockOptions(o, it) {
    const thick = this.thickOf(it);
    o.appendChild(this.styleButton(it.color, levelPx(thick), (e) => this.openStylePicker(e.currentTarget, {
      colors: PEN_COLORS, color: it.color, thick,
      onChange: ({ color, thick: t }) => {
        this.editSelected((x) => {
          if (color) x.color = color;
          if (t) x.w = thickFactor(t) * this.unitFor(this.sel.key);
        });
        if (color) this.block.color = color;
        if (t) this.block.thick = t;
        this.savePrefs();
      }
    }), "Colour and thickness"));
    const f = h(`<button type="button" role="switch" aria-checked="${!!it.fill}" class="chip-btn toggle tight${it.fill ? " on" : ""}"><span class="fill-box white"></span><span>Fill</span></button>`);
    f.addEventListener("click", () => { this.editSelected((x) => { x.fill = !x.fill; }); this.block.fill = !it.fill; this.savePrefs(); });
    o.appendChild(f);
    const vit = this.viewer.itemFor(this.sel.key);
    const photo = vit && this.doc.src(vit.p).kind === "image";
    const sc = h(`<button type="button" class="chip-btn tight">${icon("ruler")}<span>${photo ? "Scale" : "1:" + ratioForK(it.k)}</span></button>`);
    sc.addEventListener("click", () => { if (vit) this.changeScale(vit); });
    o.appendChild(sc);
    const l = this.doc.layer(it.layer);
    const lb = h(`<button type="button" class="chip-btn grow-btn">${icon("layers")}<span class="ell">${esc(l ? l.name : "Layer")}</span>${icon("chevdown")}</button>`);
    lb.addEventListener("click", async () => {
      const v = await openMenu(lb, this.doc.layers.map((x) => ({ label: x.name, value: x.id, checked: x.id === it.layer })), { above: true, align: "end" });
      if (v) this.editSelected((x) => { x.layer = v; });
    });
    o.appendChild(lb);
  }

  async blockSize(anchor) {
    const it = this.selectedItem();
    if (!it) return;
    const units = getUnits();
    const choices = sizeChoices(it, units);
    const v = await openMenu(anchor, [
      ...choices.map((c) => ({ label: c.label, value: "s" + c.i, checked: c.checked })),
      { divider: true },
      { label: "Custom size…", value: "custom" },
      { label: units === "ftin" ? "Show sizes in mm" : "Show sizes in feet and inches", value: "units" }
    ], { align: "start" });
    if (!v) return;
    if (v === "units") {
      setUnits(units === "ftin" ? "mm" : "ftin");
      this.drawSelection();
      toast(units === "ftin" ? "Sizes now in mm" : "Sizes now in feet and inches", { ms: 2000 });
      return;
    }
    let w, d, pp = it.p, name = it.name;
    if (v === "custom") {
      const f = familyOf(it.family);
      const ft = units === "ftin";
      const cur = ft ? sizeText(it.bw, it.bd, "ftin").replace(" × ", " x ") : `${Math.round(it.bw)} x ${Math.round(it.bd)}`;
      const t = await promptDialog({
        title: "Custom size",
        message: f && f.box
          ? (ft ? "Width, like 3'0\" or 900 mm." : "Width in mm, like 900, or in feet like 3'0\".")
          : (ft ? "Width x depth, like 5'0\" x 6'6\". Plain numbers are inches; add mm for millimetres." : "Width x depth in mm, like 1500 x 2000. Feet and inches work too, like 5'0\" x 6'6\"."),
        value: f && f.box ? cur.split(" x ")[0] : cur,
        okText: "Use",
        validate: (x) => (f && f.box ? (parseLen(x, units) > 50 ? null : "Type the width, like 900 or 3'0\".") : parseSizeText(x, units) ? null : "Type two sizes, like 1500 x 2000 or 5'0\" x 6'6\".")
      });
      if (t == null) return;
      if (f && f.box) { w = parseLen(t, units); d = f.box(w)[1]; }
      else ({ w, d } = parseSizeText(t, units));
    } else {
      const c = choices[Number(v.slice(1))];
      w = c.w; d = c.d; pp = c.size.p ? structuredClone(c.size.p) : null;
      if (c.size.name) name = c.size.name;
    }
    this.editSelected((x) => this.resizeBlock(x, w, d, pp, name));
  }

  // New size, keeping the back edge (the wall side) where it is.
  resizeBlock(x, w, d, pp, name) {
    const a = (x.rot * Math.PI) / 180;
    const sh = ((d - x.bd) / 2) * x.k;
    x.x1 += -Math.sin(a) * sh; x.y1 += Math.cos(a) * sh;
    x.x2 = x.x1; x.y2 = x.y1;
    x.bw = w; x.bd = d; x.p = pp; x.name = name;
  }

  blockFrame(it) {
    const a = (it.rot * Math.PI) / 180;
    return { ux: Math.cos(a), uy: Math.sin(a), vx: -Math.sin(a), vy: Math.cos(a) };
  }

  /* ---------- measuring to set the scale ---------- */

  measure(vit) {
    return new Promise((resolve) => {
      const doc = this.doc;
      const p = vit.p;
      const photo = doc.src(p).kind === "image";
      const r = this.viewer.root.getBoundingClientRect();
      const pts = [this.viewer.toBase(vit, r.left + r.width * 0.3, r.top + r.height * 0.45), this.viewer.toBase(vit, r.left + r.width * 0.7, r.top + r.height * 0.45)];
      const ui = h(`<div class="measure-ui"><svg class="measure-line"><line></line></svg><span class="m-mark" data-i="0"></span><span class="m-mark" data-i="1"></span></div>`);
      const banner = h(`<div class="measure-banner">${icon("ruler")}<span>Drag the two ends onto something you know the length of, like a door opening. Pinch to zoom in for accuracy.</span></div>`);
      const panel = h(`<form class="measure-panel" autocomplete="off">
        <label for="m-len">How long is this?</label>
        <div class="m-row"><span class="m-input"><input id="m-len" inputmode="${getUnits() === "ftin" ? "text" : "decimal"}" enterkeyhint="done" placeholder="${getUnits() === "ftin" ? "3'0\"" : "900"}"><em>${getUnits() === "ftin" ? "ft-in" : "mm"}</em></span><button type="submit" class="btn primary">Set scale</button></div>
        <p class="m-note"></p>
        <button type="button" class="btn link-btn" data-cancel>Cancel</button></form>`);
      const input = panel.querySelector("input");
      const note = panel.querySelector(".m-note");
      let result = null;
      const update = () => {
        const L = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        const mm = parseLen(input.value, getUnits());
        if (mm > 0 && L > 0) {
          const k = L / mm;
          note.textContent = photo ? "Blocks on this photo will use this length." : `That works out to about 1:${ratioForK(k)}.`;
        } else note.textContent = "";
      };
      const place = () => {
        const v = this.viewer.itemFor(p.key);
        if (!v) return;
        const g = this.viewer.geom(v);
        const sx = v.w / g.dw;
        const xy = pts.map(([bx, by]) => { const d = apply(g.b2d, bx, by); return [v.left + d[0] * sx, v.top + d[1] * sx]; });
        ui.querySelectorAll(".m-mark").forEach((m, i) => { m.style.left = xy[i][0] + "px"; m.style.top = xy[i][1] + "px"; });
        const ln = ui.querySelector("line");
        ln.setAttribute("x1", xy[0][0]); ln.setAttribute("y1", xy[0][1]); ln.setAttribute("x2", xy[1][0]); ln.setAttribute("y2", xy[1][1]);
      };
      ui.querySelectorAll(".m-mark").forEach((m) => {
        m.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          e.preventDefault();
          m.setPointerCapture(e.pointerId);
          const i = Number(m.dataset.i);
          // The end moves with the finger without jumping under it, so it stays visible.
          const v0 = this.viewer.itemFor(p.key);
          if (!v0) return;
          const start = this.viewer.toBase(v0, e.clientX, e.clientY);
          const from = pts[i].slice();
          const onMove = (ev) => {
            const v = this.viewer.itemFor(p.key);
            if (!v) return;
            const now = this.viewer.toBase(v, ev.clientX, ev.clientY);
            pts[i] = [from[0] + now[0] - start[0], from[1] + now[1] - start[1]];
            place();
            update();
          };
          const onUp = () => { m.removeEventListener("pointermove", onMove); m.removeEventListener("pointerup", onUp); m.removeEventListener("pointercancel", onUp); };
          m.addEventListener("pointermove", onMove);
          m.addEventListener("pointerup", onUp);
          m.addEventListener("pointercancel", onUp);
        });
      });
      input.addEventListener("input", update);
      this.select(null);
      this.measuring = { place };
      this.screen.classList.add("measuring");
      this.viewer.wrap.appendChild(ui);
      this.views.append(banner, panel);
      place();
      const layer = pushLayer({
        onClose: () => {
          ui.remove(); banner.remove(); panel.remove();
          this.measuring = null;
          this.screen.classList.remove("measuring");
          resolve(result);
        }
      });
      panel.addEventListener("submit", (e) => {
        e.preventDefault();
        const L = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
        const mm = parseLen(input.value, getUnits());
        if (!(mm > 0) || !(L > 0)) { note.textContent = getUnits() === "ftin" ? "Type the real length, like 3'0\" or 900mm." : "Type the real length in mm, like 900, or in feet like 3'0\"."; input.focus(); return; }
        result = L / mm;
        closeLayer(layer);
      });
      panel.querySelector("[data-cancel]").addEventListener("click", () => closeLayer(layer));
    });
  }

  /* ---------- selection ---------- */

  selectedItem() {
    if (!this.sel) return null;
    const p = this.doc.pages.find((x) => x.key === this.sel.key);
    return p ? p.items.find((x) => x.id === this.sel.id) || null : null;
  }

  select(sel) {
    this.sel = sel;
    this.drawSelection();
    if (this.active) this.renderOptions();
  }

  editSelected(fn) {
    const it = this.selectedItem();
    if (!it) return;
    this.doc.commit();
    fn(it);
    this.changed();
    this.renderOptions();
  }

  changed() {
    this.viewer.marksChanged();
    this.drawSelection();
    this.onChange && this.onChange();
  }

  drawSelection() {
    if (this.selUI) { this.selUI.remove(); this.selUI = null; }
    if (this.measuring) this.measuring.place();
    const item = this.selectedItem();
    if (!item || !this.active) return;
    const vit = this.viewer.itemFor(this.sel.key);
    if (!vit) return;
    const g = this.viewer.geom(vit);
    const b = itemBounds(item, g.unit);
    const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y]) => apply(g.b2d, x, y));
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const sx = vit.w / g.dw;
    const L = vit.left + Math.min(...xs) * sx - 6, T = vit.top + Math.min(...ys) * sx - 6;
    const W = (Math.max(...xs) - Math.min(...xs)) * sx + 12, H = (Math.max(...ys) - Math.min(...ys)) * sx + 12;
    const ui = h(`<div class="sel-ui"></div>`);
    const er = vit.el.getBoundingClientRect();
    const toWrap = (c) => [c[0] - er.left + vit.left, c[1] - er.top + vit.top];
    let pillY = T + H + 8;
    if (isBlock(item)) {
      const m = blockMatrix(item);
      const cs = [[0, 0], [item.bw, 0], [item.bw, item.bd], [0, item.bd]].map(([x, y]) => toWrap(this.viewer.toClient(vit, ...apply(m, x, y))));
      const bw = Math.hypot(cs[1][0] - cs[0][0], cs[1][1] - cs[0][1]), bh = Math.hypot(cs[3][0] - cs[0][0], cs[3][1] - cs[0][1]);
      const ang = Math.atan2(cs[1][1] - cs[0][1], cs[1][0] - cs[0][0]) * 180 / Math.PI;
      const ccx = (cs[0][0] + cs[2][0]) / 2, ccy = (cs[0][1] + cs[2][1]) / 2;
      ui.appendChild(h(`<div class="selbox" style="left:${ccx - bw / 2}px;top:${ccy - bh / 2}px;width:${bw}px;height:${bh}px;transform:rotate(${ang}deg)"></div>`));
      pillY = Math.max(...cs.map((c) => c[1])) + 10;
      ui.appendChild(h(`<span class="dim-pill" style="left:${ccx}px;top:${pillY}px">${sizeText(item.bw, item.bd, getUnits())}</span>`));
      pillY += 30;
    } else {
      ui.appendChild(h(`<div class="selbox" style="left:${L}px;top:${T}px;width:${W}px;height:${H}px"></div>`));
    }
    for (const hd of this.handlesFor(item, vit)) {
      const [x, y] = toWrap([hd.x, hd.y]);
      ui.appendChild(h(`<span class="handle${hd.k === "rot" ? " rot" : ""}" style="left:${x}px;top:${y}px">${hd.k === "rot" ? icon("turn") : ""}</span>`));
    }
    const bar = h(`<div class="floatbar" role="toolbar" aria-label="Selected mark"></div>`);
    const add = (ic, label, fn, danger) => {
      const btn = h(`<button type="button"${danger ? ' class="danger"' : ""}>${icon(ic)}<span>${esc(label)}</span></button>`);
      btn.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      bar.appendChild(btn);
    };
    if (isBlock(item)) {
      const sb = h(`<button type="button">${icon("size")}<span>Size</span></button>`);
      sb.addEventListener("click", (e) => { e.stopPropagation(); this.blockSize(sb); });
      bar.appendChild(sb);
      add("turn", "Turn", () => this.editSelected((x) => { x.rot = ((x.rot || 0) + 90) % 360; }));
      add("flip", "Flip", () => this.editSelected((x) => { x.flip = !x.flip; }));
    } else if (item.kind === "shape" && item.shape !== "line" && item.shape !== "poly") add("text", "Edit text", () => this.editText(item));
    if (item.kind === "comment") add("edit", "Edit", () => this.onComment && this.onComment("edit", this.sel.key, item.id));
    if (item.kind !== "comment" && item.kind !== "blur") add("copy", "Copy", () => this.duplicateSelected());
    add("trash", "Delete", () => this.deleteSelected(), true);
    bar.classList.toggle("labels", isBlock(item));
    const top = T - 52;
    bar.style.top = (isBlock(item) ? pillY : top < this.viewer.root.scrollTop + 4 ? T + H + 8 : top) + "px";
    ui.appendChild(bar);
    this.viewer.wrap.appendChild(ui);
    const bw = bar.offsetWidth;
    const root = this.viewer.root;
    const minX = root.scrollLeft + 8 + bw / 2, maxX = root.scrollLeft + root.clientWidth - 8 - bw / 2;
    bar.style.left = Math.max(minX, Math.min(maxX, L + W / 2)) + "px";
    const maxY = root.scrollTop + root.clientHeight - bar.offsetHeight - 8;
    if (parseFloat(bar.style.top) > maxY) bar.style.top = Math.max(root.scrollTop + 8, Math.min(maxY, T - bar.offsetHeight - 10)) + "px";
    this.selUI = ui;
  }

  // Handles in client coordinates: corners for boxes, ends for arrows and symbols.
  handlesFor(item, vit) {
    const pts = [];
    if (isBlock(item)) {
      const { ux, uy, vx, vy } = this.blockFrame(item);
      const hw = (item.bw / 2) * item.k, hd = (item.bd / 2) * item.k;
      const cx = item.x1, cy = item.y1;
      pts.push({ k: "br", b: [cx + ux * hw, cy + uy * hw] }, { k: "bl", b: [cx - ux * hw, cy - uy * hw] });
      const f = familyOf(item.family);
      if (!f || !f.box) pts.push({ k: "bb", b: [cx + vx * hd, cy + vy * hd] }, { k: "bt", b: [cx - vx * hd, cy - vy * hd] });
      const off = 34 * this.viewer.basePerPx(vit);
      pts.push({ k: "rot", b: [cx - vx * (hd + off), cy - vy * (hd + off)] });
    } else if (item.kind === "shape" && item.shape === "poly") {
      for (let i = 0; i < item.pts.length; i += 2) pts.push({ k: "v" + i / 2, b: [item.pts[i], item.pts[i + 1]] });
    } else if (item.kind === "shape" && POINT_SHAPES.has(item.shape)) {
      pts.push({ k: "p1", b: [item.x1, item.y1] }, { k: "p2", b: [item.x2, item.y2] });
    } else if ((item.kind === "shape" && CLOSED_SHAPES.has(item.shape)) || item.kind === "blur" || (item.kind === "comment" && item.ctype === "box")) {
      const r = item.kind === "shape" ? { x0: Math.min(item.x1, item.x2), y0: Math.min(item.y1, item.y2), x1: Math.max(item.x1, item.x2), y1: Math.max(item.y1, item.y2) } : { x0: Math.min(item.x0, item.x1), y0: Math.min(item.y0, item.y1), x1: Math.max(item.x0, item.x1), y1: Math.max(item.y0, item.y1) };
      pts.push({ k: "c00", b: [r.x0, r.y0] }, { k: "c10", b: [r.x1, r.y0] }, { k: "c11", b: [r.x1, r.y1] }, { k: "c01", b: [r.x0, r.y1] });
    } else if (item.kind === "comment" && item.ctype === "leader") {
      pts.push({ k: "tip", b: [item.ax, item.ay] });
    }
    return pts.map((p) => { const c = this.viewer.toClient(vit, ...p.b); return { k: p.k, x: c[0], y: c[1] }; });
  }

  async editText(item) {
    const key = this.sel.key;
    const isSection = item.shape === "section";
    const v = await promptDialog({
      title: isSection ? "Section marker" : "Text inside",
      message: isSection ? "First line: the section name. Second line: the sheet it's on (optional)." : "",
      value: isSection ? [item.text || "A", item.text2 || ""].filter((x, i) => i === 0 || x).join("\n") : item.text || "",
      multiline: true,
      okText: "Done"
    });
    if (v == null) return;
    this.sel = { key, id: item.id };
    this.editSelected((it) => {
      if (isSection) {
        const [a, b] = v.split("\n");
        it.text = (a || "").trim();
        it.text2 = (b || "").trim();
      } else it.text = v.replace(/\s+$/, "");
    });
  }

  duplicateSelected() {
    const item = this.selectedItem();
    if (!item) return;
    const p = this.doc.pages.find((x) => x.key === this.sel.key);
    const unit = this.unitFor(this.sel.key);
    const off = unit * 0.02;
    this.doc.commit();
    const c = structuredClone(item);
    c.id = newId();
    shiftItem(c, off, off);
    p.items.push(c);
    this.sel = { key: p.key, id: c.id };
    this.changed();
  }

  deleteSelected() {
    const item = this.selectedItem();
    if (!item) return;
    const p = this.doc.pages.find((x) => x.key === this.sel.key);
    this.doc.commit();
    p.items = p.items.filter((x) => x.id !== item.id);
    this.sel = null;
    this.changed();
    this.renderOptions();
    toast("Deleted", { ms: 2500, action: { label: "Undo", fn: () => { this.doc.undo(); } } });
  }

  /* ---------- hit testing ---------- */

  hitItem(vit, bx, by, { includeComments = true } = {}) {
    const doc = this.doc;
    const g = this.viewer.geom(vit);
    const tol = 14 * this.viewer.basePerPx(vit);
    const vis = new Map(doc.layers.map((l) => [l.id, l.visible]));
    const items = vit.p.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if ((it.kind === "ink" || it.kind === "shape") && vis.get(it.layer) === false) continue;
      if (it.kind === "comment" && (!includeComments || !doc.commentsVisible)) continue;
      if (it.kind === "ink") {
        if (distToPolyline(bx, by, it.pts) <= tol + it.w / 2) return it;
      } else if (it.kind === "shape" && (it.shape === "arrow" || it.shape === "curved" || it.shape === "line")) {
        if (distToSeg(bx, by, it.x1, it.y1, it.x2, it.y2) <= tol + it.w) return it;
      } else if (isBlock(it)) {
        const [lx, ly] = apply(inv(blockMatrix(it)), bx, by);
        const t = tol / it.k;
        if (lx >= -t && lx <= it.bw + t && ly >= -t && ly <= it.bd + t) return it;
      } else if (it.kind === "shape" && it.shape === "poly") {
        const b = bbox(it.pts);
        if (bx >= b.x0 - tol && bx <= b.x1 + tol && by >= b.y0 - tol && by <= b.y1 + tol) return it;
      } else {
        const b = itemBounds(it, g.unit);
        if (bx >= b.x0 - tol && bx <= b.x1 + tol && by >= b.y0 - tol && by <= b.y1 + tol) return it;
      }
    }
    return null;
  }

  hitHandle(e) {
    const item = this.selectedItem();
    if (!item) return null;
    const vit = this.viewer.itemFor(this.sel.key);
    if (!vit) return null;
    // A small block on screen: a touch on the block itself moves it, so only the turn handle
    // and handles clear of the block count.
    let inside = null;
    if (isBlock(item)) {
      const [bx, by] = this.viewer.toBase(vit, e.clientX, e.clientY);
      const [lx, ly] = apply(inv(blockMatrix(item)), bx, by);
      inside = lx >= 0 && lx <= item.bw && ly >= 0 && ly <= item.bd;
    }
    let best = null, bd = 22;
    for (const hd of this.handlesFor(item, vit)) {
      const d = Math.hypot(e.clientX - hd.x, e.clientY - hd.y);
      if (inside && hd.k !== "rot") continue;
      if (d < bd) { bd = d; best = hd.k; }
    }
    return best;
  }

  /* ---------- pointer handling ---------- */

  down(e) {
    if (!this.active) return;
    if (e.target.closest(".floatbar, .composer, .pin, .pin-area, .draw-hint")) return;
    if (e.pointerType === "touch") this.touches.add(e.pointerId);
    if (e.pointerType === "pen") this.penSeen = true;
    if (this.touches.size > 1) { this.cancelGesture(); return; }
    // S Pen with its side button held (or a pen's eraser end) erases, whatever the tool.
    const penButton = e.pointerType === "pen" && ((e.buttons & 2) || (e.buttons & 32) || e.button === 2 || e.button === 5);
    if (e.button > 0 && !penButton) return;
    if (this.composer) { this.closeComposer(); return; }
    const vit = this.viewer.pageAt(e.clientX, e.clientY);
    if (!vit) return;
    const [bx, by] = this.viewer.toBase(vit, e.clientX, e.clientY);
    const base = { id: e.pointerId, vit, key: vit.p.key, x: e.clientX, y: e.clientY, b0: [bx, by], t: performance.now() };
    const fingerScrolls = e.pointerType === "touch" && this.penSeen;
    let tool = this.tool;
    if (this.measuring) {
      this.g = { ...base, type: "pan" };
      return this.capture(e);
    }
    if (penButton) {
      if (this.composer) this.closeComposer();
      if (this.sel) this.select(null);
      this.g = { ...base, type: "erase", erased: 0, viaButton: true };
      this.eraseAt(vit, bx, by);
      this.showEraser(this.g, bx, by);
      return this.capture(e);
    }

    // In the select and shapes tools, a selected mark can be moved or resized.
    if ((tool === "select" || tool === "shapes" || tool === "comment") && this.sel && this.sel.key === vit.p.key && !fingerScrolls) {
      const hk = this.hitHandle(e);
      const item = this.selectedItem();
      if (hk) { this.startEdit(base, item, hk); return this.capture(e); }
      const hit = this.hitItem(vit, bx, by);
      if (hit && hit.id === item.id) { this.startEdit(base, item, "move"); return this.capture(e); }
    }
    if (tool === "select" && !fingerScrolls) {
      const hit = this.hitItem(vit, bx, by);
      if (hit) {
        this.select({ key: vit.p.key, id: hit.id });
        this.startEdit(base, hit, "move");
        return this.capture(e);
      }
      this.select(null);
      this.g = { ...base, type: "pan" };
      return this.capture(e);
    }
    if (fingerScrolls || !DRAW_TOOLS.has(tool)) {
      this.g = { ...base, type: "pan" };
      return this.capture(e);
    }
    if (this.sel && tool !== "select") this.select(null);
    if (tool === "pen") {
      this.g = { ...base, type: "ink", pts: [bx, by], hold: { x: e.clientX, y: e.clientY } };
      this.armHold(this.g);
    } else if (tool === "eraser") {
      this.g = { ...base, type: "erase", erased: 0 };
      this.eraseAt(vit, bx, by);
      this.showEraser(this.g, bx, by);
    } else if (tool === "blur") {
      this.g = { ...base, type: "blur", b1: [bx, by] };
    } else if (tool === "shapes") {
      this.g = { ...base, type: "shape", b1: [bx, by] };
    } else if (tool === "comment") {
      const ct = this.comment.ctype;
      this.g = { ...base, type: "c-" + ct, pts: [bx, by], b1: [bx, by] };
    }
    this.capture(e);
  }

  capture(e) {
    try { this.viewer.root.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  }

  startEdit(base, item, mode) {
    this.g = { ...base, type: "edit", mode, orig: structuredClone(item), committed: false };
  }

  move(e) {
    const g = this.g;
    if (!g || e.pointerId !== g.id) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (g.type === "pan") {
      this.viewer.panBy(g.x - e.clientX, g.y - e.clientY);
      g.x = e.clientX; g.y = e.clientY;
      return;
    }
    const last = events[events.length - 1] || e;
    const [bx, by] = this.viewer.toBase(g.vit, last.clientX, last.clientY);
    g.b1 = [bx, by];
    const unit = this.viewer.geom(g.vit).unit;
    if (g.type === "ink" && e.pointerType === "pen" && (e.buttons & 34) && g.pts.length < 40) {
      clearTimeout(g.holdTimer);
      g.type = "erase";
      g.erased = 0;
      g.viaButton = true;
      this.viewer.setLive(g.key, "");
    }
    if (g.type === "ink" && g.snap) return;
    if (g.type === "ink" && Math.hypot(last.clientX - g.hold.x, last.clientY - g.hold.y) > 5) {
      g.hold = { x: last.clientX, y: last.clientY };
      this.armHold(g);
    }
    if (g.type === "ink" || g.type === "c-free") {
      const tol = 1.2 * this.viewer.basePerPx(g.vit);
      for (const ev of events) {
        const [x, y] = this.viewer.toBase(g.vit, ev.clientX, ev.clientY);
        const n = g.pts.length;
        if (Math.hypot(x - g.pts[n - 2], y - g.pts[n - 1]) >= tol) g.pts.push(x, y);
      }
      if (g.type === "ink") {
        const pts = this.pen.straightOnly ? [g.pts[0], g.pts[1], bx, by] : g.pts;
        this.viewer.setLive(g.key, drawableToSVG(inkDrawable(this.inkItem(pts, unit))));
      } else {
        this.viewer.setLive(g.key, drawableToSVG(commentDrawable({ ctype: "free", pts: g.pts, color: this.comment.color, cloud: false, w: unit * 0.0018 }, unit)));
      }
    } else if (g.type === "erase") {
      for (const ev of events) {
        const [x, y] = this.viewer.toBase(g.vit, ev.clientX, ev.clientY);
        this.eraseAt(g.vit, x, y);
      }
      this.showEraser(g, bx, by);
    } else if (g.type === "blur") {
      const [x0, y0] = g.b0;
      this.viewer.setLive(g.key, `<rect x="${Math.min(x0, bx)}" y="${Math.min(y0, by)}" width="${Math.abs(bx - x0)}" height="${Math.abs(by - y0)}" fill="rgba(31,78,121,0.15)" stroke="#1F4E79" stroke-dasharray="${unit * 0.006}" stroke-width="${unit * 0.0015}"/>`);
    } else if (g.type === "shape") {
      this.viewer.setLive(g.key, drawableToSVG(shapeDrawable(this.shapeItem(g.b0, g.b1, unit), unit)));
    } else if (g.type === "c-box") {
      const [x0, y0] = g.b0;
      this.viewer.setLive(g.key, drawableToSVG(commentDrawable({ ctype: "box", x0, y0, x1: bx, y1: by, color: this.comment.color, cloud: this.comment.cloud, w: unit * 0.0018 }, unit)));
    } else if (g.type === "c-leader") {
      const [ax, ay] = g.b0;
      this.viewer.setLive(g.key, `<path d="M${bx} ${by}L${ax} ${ay}" stroke="${this.comment.color}" stroke-width="${unit * 0.0018}" fill="none"/>`);
    } else if (g.type === "edit") {
      this.applyEdit(g, bx, by);
    }
  }

  up(e, cancelled = false) {
    if (e.pointerType === "touch") this.touches.delete(e.pointerId);
    const g = this.g;
    if (!g || e.pointerId !== g.id) return;
    this.g = null;
    clearTimeout(g.holdTimer);
    if (cancelled) { this.viewer.setLive(g.key, ""); return; }
    const doc = this.doc;
    const p = g.vit.p;
    const unit = this.viewer.geom(g.vit).unit;
    const moved = Math.hypot(e.clientX - g.x, e.clientY - g.y) > 6 || performance.now() - g.t > 250;
    this.viewer.setLive(g.key, "");
    if (g.type === "ink" && g.snap) {
      const layer = doc.ensureLayer();
      doc.commit();
      p.items.push({ ...this.snapItem(g.snap, unit), id: newId(), layer: layer.id });
      this.updateChip();
      this.changed();
    } else if (g.type === "ink") {
      let pts = g.pts;
      if (this.pen.straightOnly) {
        const [bx, by] = g.b1 || g.b0;
        pts = [pts[0], pts[1], bx, by];
      } else {
        const tol = 1.5 * this.viewer.basePerPx(g.vit);
        if (this.pen.smooth) pts = smoothPoints(thinPoints(pts, tol));
      }
      if (pts.length === 2) pts = [pts[0], pts[1], pts[0] + 0.01, pts[1]];
      const layer = doc.ensureLayer();
      doc.commit();
      p.items.push({ ...this.inkItem(pts, unit), id: newId(), layer: layer.id });
      this.updateChip();
      this.changed();
    } else if (g.type === "erase") {
      this.viewer.setLive(g.key, "");
      if (g.erased) this.changed();
    } else if (g.type === "blur") {
      const [x0, y0] = g.b0, [x1, y1] = g.b1 || g.b0;
      if (Math.abs(x1 - x0) < unit * 0.005 || Math.abs(y1 - y0) < unit * 0.005) return;
      doc.commit();
      p.items.push({ id: newId(), kind: "blur", x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
      this.changed();
    } else if (g.type === "shape") {
      let b1 = g.b1 || g.b0;
      if (!moved || Math.hypot(b1[0] - g.b0[0], b1[1] - g.b0[1]) < unit * 0.01) {
        const d = unit * 0.06;
        b1 = POINT_SHAPES.has(this.shape.shape) ? [g.b0[0] + (this.shape.shape === "north" ? 0 : d), g.b0[1] - (this.shape.shape === "north" ? d : 0)] : [g.b0[0] + d * 1.4, g.b0[1] + d];
      }
      const layer = doc.ensureLayer();
      doc.commit();
      const it = { ...this.shapeItem(g.b0, b1, unit), id: newId(), layer: layer.id };
      p.items.push(it);
      this.sel = { key: p.key, id: it.id };
      this.updateChip();
      this.changed();
      this.renderOptions();
    } else if (g.type === "c-box" || g.type === "c-free" || g.type === "c-leader") {
      this.finishCommentShape(g, p, unit, moved);
    } else if (g.type === "edit") {
      if (g.committed) this.changed();
      else if (!moved && this.tool === "select") this.drawSelection();
    }
  }

  cancelGesture() {
    const g = this.g;
    if (!g) return;
    this.g = null;
    clearTimeout(g.holdTimer);
    if (g.type === "edit" && g.committed) { this.changed(); return; }
    this.viewer.setLive(g.key, "");
  }

  inkItem(pts, unit) {
    const k = PEN_KIND[this.pen.type];
    return {
      kind: "ink", pen: this.pen.type,
      color: this.pen.type === "highlighter" ? this.pen.hcolor : this.pen.color,
      w: thickFactor(this.pen.thick) * unit * k.mult, pts
    };
  }

  armHold(g) {
    clearTimeout(g.holdTimer);
    if (this.pen.straightOnly || this.pen.snap === false) return;
    g.holdTimer = setTimeout(() => this.trySnap(g), HOLD_MS);
  }

  trySnap(g) {
    if (this.g !== g || g.type !== "ink" || g.snap) return;
    const r = recognizeShape(g.pts);
    if (!r) return;
    if (this.pen.type === "highlighter" && r.shape !== "line") return;
    g.snap = r;
    const unit = this.viewer.geom(g.vit).unit;
    this.viewer.setLive(g.key, drawableToSVG(drawableFor(this.snapItem(r, unit), unit)));
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* not supported */ }
  }

  snapItem(r, unit) {
    if (this.pen.type === "highlighter") return this.inkItem([r.x1, r.y1, r.x2, r.y2], unit);
    const k = PEN_KIND[this.pen.type] || PEN_KIND.pen;
    const it = { kind: "shape", shape: r.shape, color: this.pen.color, w: thickFactor(this.pen.thick) * unit * k.mult, fill: false, text: "" };
    if (r.pts) {
      const b = bbox(r.pts);
      Object.assign(it, { pts: r.pts.slice(), x1: b.x0, y1: b.y0, x2: b.x1, y2: b.y1 });
    } else Object.assign(it, { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
    return it;
  }

  shapeItem(b0, b1, unit) {
    const st = this.shape;
    const it = { kind: "shape", shape: st.shape, color: st.color, w: thickFactor(st.thick) * unit, fill: !!st.fill, x1: b0[0], y1: b0[1], x2: b1[0], y2: b1[1], text: "" };
    if (st.shape === "polygon") it.sides = st.sides || 6;
    if (st.shape === "section") it.text = "A";
    if (st.shape === "level") it.text = "+0.00";
    return it;
  }

  showEraser(g, bx, by) {
    const bpp = this.viewer.basePerPx(g.vit);
    const r = (this.eraser.size / 2) * bpp;
    this.viewer.setLive(g.key, `<circle cx="${bx}" cy="${by}" r="${r}" fill="rgba(31,78,121,0.08)" stroke="#1F4E79" stroke-width="${1.5 * bpp}"/>`);
  }

  // Erases what the eraser circle touches: whole marks, or in "part of a line" mode, just the
  // piece of a pen stroke under it (shapes and blocks still go whole).
  eraseAt(vit, bx, by) {
    const doc = this.doc;
    const g = this.g;
    const r = (this.eraser.size / 2) * this.viewer.basePerPx(vit);
    const unit = this.viewer.geom(vit).unit;
    const vis = new Map(doc.layers.map((l) => [l.id, l.visible]));
    const part = this.eraser.mode === "part";
    const out = [];
    let changed = false;
    for (const it of vit.p.items) {
      if (it.kind === "comment" || ((it.kind === "ink" || it.kind === "shape") && vis.get(it.layer) === false)) { out.push(it); continue; }
      let hit = false;
      if (it.kind === "ink") hit = distToPolyline(bx, by, it.pts) <= r + it.w / 2;
      else if (it.kind === "shape" && (it.shape === "arrow" || it.shape === "curved" || it.shape === "line")) hit = distToSeg(bx, by, it.x1, it.y1, it.x2, it.y2) <= r + it.w;
      else if (isBlock(it)) {
        const [lx, ly] = apply(inv(blockMatrix(it)), bx, by);
        const t = r / it.k;
        hit = lx >= -t && lx <= it.bw + t && ly >= -t && ly <= it.bd + t;
      } else {
        const b = itemBounds(it, unit);
        hit = bx >= b.x0 - r && bx <= b.x1 + r && by >= b.y0 - r && by <= b.y1 + r;
      }
      if (!hit) { out.push(it); continue; }
      if (!changed && g && !g.erased) doc.commit();
      changed = true;
      if (part && it.kind === "ink") {
        for (const run of cutStroke(it.pts, bx, by, r + it.w / 2)) out.push({ ...it, id: newId(), pts: run });
      }
    }
    if (!changed) return;
    if (g) g.erased++;
    vit.p.items = out;
    this.viewer.marksChanged();
  }


  applyEdit(g, bx, by) {
    const item = this.selectedItem();
    if (!item) return;
    if (!g.committed) { this.doc.commit(); g.committed = true; }
    const dx = bx - g.b0[0], dy = by - g.b0[1];
    const o = g.orig;
    if (g.mode === "move") {
      Object.assign(item, structuredClone(o));
      shiftItem(item, dx, dy);
    } else if (isBlock(item) && g.mode === "rot") {
      let a = (Math.atan2(by - o.y1, bx - o.x1) * 180) / Math.PI + 90;
      a = ((a % 360) + 360) % 360;
      const q90 = Math.round(a / 90) * 90, q15 = Math.round(a / 15) * 15;
      if (Math.abs(a - q90) < 6) a = q90 % 360;
      else if (Math.abs(a - q15) < 3) a = q15 % 360;
      item.rot = a;
    } else if (isBlock(item) && g.mode[0] === "b") {
      const { ux, uy, vx, vy } = this.blockFrame(o);
      const horiz = g.mode === "bl" || g.mode === "br";
      const sgn = g.mode === "br" || g.mode === "bb" ? 1 : -1;
      const along = horiz ? dx * ux + dy * uy : dx * vx + dy * vy;
      const old = horiz ? o.bw : o.bd;
      const step = getUnits() === "ftin" ? INCH : 10;
      const nv = Math.max(step * 4, Math.round((old + (sgn * along) / o.k) / step) * step);
      const shift = (sgn * (nv - old) / 2) * o.k;
      const f = familyOf(o.family);
      let cx = o.x1 + (horiz ? ux : vx) * shift, cy = o.y1 + (horiz ? uy : vy) * shift;
      if (horiz) {
        item.bw = nv;
        if (f && f.box) {
          item.bd = f.box(nv)[1];
          const sv = ((item.bd - o.bd) / 2) * o.k;
          cx += vx * sv; cy += vy * sv;
        }
      } else item.bd = nv;
      item.x1 = item.x2 = cx;
      item.y1 = item.y2 = cy;
    } else if (g.mode[0] === "v" && item.pts) {
      const i = Number(g.mode.slice(1));
      item.pts[2 * i] = o.pts[2 * i] + dx;
      item.pts[2 * i + 1] = o.pts[2 * i + 1] + dy;
      const b = bbox(item.pts);
      item.x1 = b.x0; item.y1 = b.y0; item.x2 = b.x1; item.y2 = b.y1;
    } else if (g.mode === "p1") { item.x1 = o.x1 + dx; item.y1 = o.y1 + dy; }
    else if (g.mode === "p2") { item.x2 = o.x2 + dx; item.y2 = o.y2 + dy; }
    else if (g.mode === "tip") { item.ax = o.ax + dx; item.ay = o.ay + dy; }
    else if (g.mode[0] === "c") {
      const isShape = item.kind === "shape";
      const r = isShape ? { x0: Math.min(o.x1, o.x2), y0: Math.min(o.y1, o.y2), x1: Math.max(o.x1, o.x2), y1: Math.max(o.y1, o.y2) } : { x0: Math.min(o.x0, o.x1), y0: Math.min(o.y0, o.y1), x1: Math.max(o.x0, o.x1), y1: Math.max(o.y0, o.y1) };
      if (g.mode[1] === "0") r.x0 += dx; else r.x1 += dx;
      if (g.mode[2] === "0") r.y0 += dy; else r.y1 += dy;
      if (isShape) { item.x1 = r.x0; item.y1 = r.y0; item.x2 = r.x1; item.y2 = r.y1; }
      else { item.x0 = r.x0; item.y0 = r.y0; item.x1 = r.x1; item.y1 = r.y1; }
    }
    this.viewer.marksChanged();
    this.drawSelection();
  }

  /* ---------- comments ---------- */

  async finishCommentShape(g, p, unit, moved) {
    const [x0, y0] = g.b0;
    const [x1, y1] = g.b1 || g.b0;
    const color = this.comment.color;
    const w = unit * 0.0018;
    let draft;
    if (g.type === "c-box") {
      let bx1 = x1, by1 = y1;
      if (!moved || (Math.abs(x1 - x0) < unit * 0.01 && Math.abs(y1 - y0) < unit * 0.01)) { bx1 = x0 + unit * 0.08; by1 = y0 + unit * 0.05; }
      draft = { kind: "comment", ctype: "box", color, cloud: this.comment.cloud, w, x0: Math.min(x0, bx1), y0: Math.min(y0, by1), x1: Math.max(x0, bx1), y1: Math.max(y0, by1) };
    } else if (g.type === "c-free") {
      let pts = g.pts;
      if (pts.length < 8) return;
      pts = smoothPoints(thinPoints(pts, 2 * this.viewer.basePerPx(g.vit)), 1);
      draft = { kind: "comment", ctype: "free", color, cloud: this.comment.cloud, w, pts };
    } else {
      let tx = x1, ty = y1;
      if (!moved || Math.hypot(x1 - x0, y1 - y0) < unit * 0.01) { tx = x0 + unit * 0.05; ty = y0 - unit * 0.06; }
      draft = { kind: "comment", ctype: "leader", color, w, ax: x0, ay: y0, tx, ty, tw: unit * 0.1, th: unit * 0.02, fs: Math.max(unit * 0.011, 7) };
    }
    this.viewer.setLive(p.key, drawableToSVG(commentDrawable(draft.ctype === "leader" ? { ...draft, text: "" } : draft, unit)));
    const author = await this.askAuthor();
    if (author == null) { this.viewer.setLive(p.key, ""); return; }
    this.openComposer(p, draft, "", (text) => {
      this.viewer.setLive(p.key, "");
      if (text == null || !text.trim()) return;
      const now = Date.now();
      const item = { ...draft, id: newId("c"), text: text.trim(), author, created: now, modified: now };
      if (item.ctype === "leader") sizeLeader(item);
      this.doc.commit();
      p.items.push(item);
      this.changed();
    });
  }

  openComposer(p, anchorItem, value, done) {
    this.closeComposer();
    const vit = this.viewer.itemFor(p.key);
    if (!vit) return;
    const g = this.viewer.geom(vit);
    const b = itemBounds(anchorItem, g.unit);
    const corners = [[b.x0, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x1, b.y0]].map(([x, y]) => apply(g.b2d, x, y));
    const sx = vit.w / g.dw;
    const bottom = vit.top + Math.max(...corners.map((c) => c[1])) * sx;
    const top = vit.top + Math.min(...corners.map((c) => c[1])) * sx;
    const card = h(`<form class="composer" aria-label="Comment">
      <label><span class="pop-label">Comment</span><textarea rows="2" class="input"></textarea></label>
      <div class="composer-row"><span class="meta"></span>
        <button type="button" class="btn link-btn" data-cancel>Cancel</button>
        <button type="submit" class="btn primary">${value ? "Save" : "Add comment"}</button></div></form>`);
    const ta = card.querySelector("textarea");
    ta.value = value || "";
    const pageNo = this.doc.pages.indexOf(p) + 1;
    card.querySelector(".meta").textContent = `${settings.get("author", "")} · Page ${pageNo}`;
    const rootW = this.viewer.root.clientWidth;
    const cw = Math.min(rootW - 24, 420);
    card.style.width = cw + "px";
    card.style.left = this.viewer.root.scrollLeft + (rootW - cw) / 2 + "px";
    const below = bottom + 12;
    const fitsBelow = below + 150 < this.viewer.root.scrollTop + this.viewer.root.clientHeight;
    card.style.top = (fitsBelow ? below : Math.max(this.viewer.root.scrollTop + 8, top - 160)) + "px";
    const finish = (text) => { this.closeComposer(); done(text); };
    card.addEventListener("submit", (e) => { e.preventDefault(); finish(ta.value); });
    card.querySelector("[data-cancel]").addEventListener("click", () => finish(null));
    card.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.viewer.wrap.appendChild(card);
    this.composer = { el: card, done };
    setTimeout(() => { ta.focus(); card.scrollIntoView({ block: "nearest" }); }, 50);
  }

  closeComposer() {
    if (!this.composer) return;
    const c = this.composer;
    this.composer = null;
    c.el.remove();
  }
}

export function shiftItem(it, dx, dy) {
  if (it.kind === "ink" || (it.kind === "comment" && it.ctype === "free")) {
    for (let i = 0; i < it.pts.length; i += 2) { it.pts[i] += dx; it.pts[i + 1] += dy; }
  } else if (it.kind === "shape") {
    it.x1 += dx; it.y1 += dy; it.x2 += dx; it.y2 += dy;
    if (it.pts) for (let i = 0; i < it.pts.length; i += 2) { it.pts[i] += dx; it.pts[i + 1] += dy; }
  } else if (it.kind === "blur" || (it.kind === "comment" && it.ctype === "box")) {
    it.x0 += dx; it.y0 += dy; it.x1 += dx; it.y1 += dy;
  } else if (it.kind === "comment" && it.ctype === "leader") {
    it.ax += dx; it.ay += dy; it.tx += dx; it.ty += dy;
  }
}

let mctx = null;
export function sizeLeader(item) {
  if (!mctx) mctx = new OffscreenCanvas(8, 8).getContext("2d");
  mctx.font = `${item.fs}px Helvetica, Arial, sans-serif`;
  const lines = String(item.text || "").split("\n");
  const w = Math.max(...lines.map((l) => mctx.measureText(l).width), item.fs * 2);
  item.tw = w + item.fs * 0.9;
  item.th = item.fs * (0.7 + lines.length * 1.2);
}

// Removes the part of a stroke inside a circle; returns the pieces that are left.
function cutStroke(pts, cx, cy, R) {
  const step = Math.max(R / 3, 1e-6);
  const dense = [pts[0], pts[1]];
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) dense.push(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
  }
  const runs = [];
  let cur = [];
  for (let i = 0; i < dense.length; i += 2) {
    if (Math.hypot(dense[i] - cx, dense[i + 1] - cy) <= R) {
      if (cur.length >= 4) runs.push(cur);
      cur = [];
    } else cur.push(dense[i], dense[i + 1]);
  }
  if (cur.length >= 4) runs.push(cur);
  return runs.map((r) => thinPoints(r, step * 0.9));
}
