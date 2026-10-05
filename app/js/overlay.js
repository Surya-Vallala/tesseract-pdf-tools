// What's drawn on top of each page in the viewer: your marks, blurs, comments,
// the watermark preview and comment pins.
import { pageGeom } from "./geom.js";
import { drawableFor, drawableToSVG, commentAnchor } from "./shapes.js";
import { wmAppliesTo, wmSVG } from "./watermark.js";
import { apply } from "./geom.js";
import { icon } from "./ui.js";

const NS = "http://www.w3.org/2000/svg";

function svgEl(cls) {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("class", cls);
  s.setAttribute("preserveAspectRatio", "none");
  return s;
}

export function ensureOverlay(it) {
  if (it.ov) return it.ov;
  const marks = svgEl("ov ov-marks");
  const blurs = document.createElement("div");
  blurs.className = "ov ov-blurs";
  const notes = svgEl("ov ov-notes");
  const pins = document.createElement("div");
  pins.className = "ov ov-pins";
  it.el.append(marks, blurs, notes, pins);
  it.ov = { marks, blurs, notes, pins, live: "" };
  return it.ov;
}

const m2s = (m) => `matrix(${m.map((v) => Math.round(v * 10000) / 10000).join(" ")})`;

export function renderOverlay(doc, it, { selectedId = null } = {}) {
  const ov = ensureOverlay(it);
  const p = it.p;
  const g = pageGeom(doc, p);
  it.g = g;
  const vb = `0 0 ${g.dw} ${g.dh}`;
  ov.marks.setAttribute("viewBox", vb);
  ov.notes.setAttribute("viewBox", vb);
  const tf = m2s(g.b2d);
  const layerVisible = new Map(doc.layers.map((l) => [l.id, l.visible]));
  let marks = "";
  let notes = "";
  let blurs = "";
  let pins = "";
  for (const item of p.items) {
    if (item.kind === "ink" || item.kind === "shape") {
      if (layerVisible.get(item.layer) === false) continue;
      marks += `<g data-id="${item.id}">${drawableToSVG(drawableFor(item, g.unit))}</g>`;
    } else if (item.kind === "blur") {
      const a = apply(g.b2d, item.x0, item.y0), b = apply(g.b2d, item.x1, item.y1);
      const x0 = Math.min(a[0], b[0]) / g.dw * 100, y0 = Math.min(a[1], b[1]) / g.dh * 100;
      const x1 = Math.max(a[0], b[0]) / g.dw * 100, y1 = Math.max(a[1], b[1]) / g.dh * 100;
      blurs += `<div class="blur" data-id="${item.id}" style="left:${x0}%;top:${y0}%;width:${x1 - x0}%;height:${y1 - y0}%"></div>`;
    } else if (item.kind === "comment" && doc.commentsVisible) {
      notes += `<g data-id="${item.id}">${drawableToSVG(drawableFor(item, g.unit))}</g>`;
      if (item.ctype === "leader") {
        const a = apply(g.b2d, item.tx, item.ty), b = apply(g.b2d, item.tx + item.tw, item.ty + item.th);
        const x0 = Math.min(a[0], b[0]) / g.dw * 100, y0 = Math.min(a[1], b[1]) / g.dh * 100;
        const x1 = Math.max(a[0], b[0]) / g.dw * 100, y1 = Math.max(a[1], b[1]) / g.dh * 100;
        pins += `<button type="button" class="pin-area" data-id="${item.id}" aria-label="Comment: ${escAttr(item.text)}" style="left:${x0}%;top:${y0}%;width:${x1 - x0}%;height:${y1 - y0}%"></button>`;
      } else {
        const [ax, ay] = commentAnchor(item);
        const d = apply(g.b2d, ax, ay);
        pins += `<button type="button" class="pin" data-id="${item.id}" aria-label="Comment: ${escAttr(item.text)}" style="left:${d[0] / g.dw * 100}%;top:${d[1] / g.dh * 100}%;background:${item.color}">${icon("comment")}</button>`;
      }
    }
  }
  let wm = "";
  if (doc.watermark && wmAppliesTo(doc.watermark, p.key)) wm = wmSVG(doc.watermark, g.dw, g.dh);
  ov.marks.innerHTML = `${wm}<g transform="${tf}">${marks}<g class="live">${ov.live || ""}</g></g>`;
  ov.notes.innerHTML = `<g transform="${tf}">${notes}</g>`;
  ov.blurs.innerHTML = blurs;
  ov.pins.innerHTML = pins;
  it.ovVer = doc.ovVersion;
}

export function setLive(doc, it, svg) {
  const ov = ensureOverlay(it);
  ov.live = svg;
  const g = ov.marks.querySelector("g.live");
  if (g) g.innerHTML = svg;
  else renderOverlay(doc, it);
}

function escAttr(s) {
  return String(s || "").slice(0, 80).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
