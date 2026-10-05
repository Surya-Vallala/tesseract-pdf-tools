// Geometry of marks (pen strokes, shapes, comments) in base units.
// The same description is drawn on screen (SVG) and written into the PDF, so they match.

import { blockParts } from "./blocks.js";
import { mul, apply } from "./geom.js";
import { LINE_KINDS, BOX_KINDS, lineParts, boxParts, layoutText } from "./dgeom.js";
export { LINE_KINDS, BOX_KINDS };

export const THICKNESS = { fine: 0.0012, medium: 0.0025, thick: 0.005 };

// Thickness is a level from 1 (finest) to 10 (thickest), as a share of the sheet size so
// lines look the same on A1 and A4. Older settings used fine / medium / thick.
const OLD_LEVEL = { fine: 3, medium: 6, thick: 8 };
export function levelOf(t) {
  if (typeof t === "number" && isFinite(t)) return Math.max(1, Math.min(10, Math.round(t)));
  return OLD_LEVEL[t] || 6;
}
export function thickFactor(t) {
  return 0.0006 * Math.pow(1.35, levelOf(t) - 1);
}
/** The level nearest to a line width w (base units) on a page with this unit. */
export function levelForWidth(w, unit, mult = 1) {
  const r = w / (unit * mult);
  let best = 6, bd = Infinity;
  for (let l = 1; l <= 10; l++) {
    const d = Math.abs(Math.log(r / thickFactor(l)));
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}
/** Bar height in px used to preview a level in buttons. */
export function levelPx(t) {
  return Math.max(1, Math.round(levelOf(t) * 0.85));
}
export const PEN_KIND = {
  pen: { mult: 1, opacity: 1 },
  marker: { mult: 2.6, opacity: 0.85 },
  highlighter: { mult: 7, opacity: 0.35, multiply: true }
};
export const PEN_COLORS = ["#D32F2F", "#1C1C1A", "#1565C0", "#2E7D32", "#E65100", "#7B1FA2"];
export const HIGHLIGHT_COLORS = ["#FFEB3B", "#76FF03", "#40C4FF", "#FF80AB", "#FFAB40", "#E040FB"];
export const COMMENT_COLORS = ["#B07800", "#C62828", "#1565C0", "#2E7D32"];
export const SHAPE_NAMES = {
  arrow: "Arrow", curved: "Curved arrow", rect: "Rectangle", circle: "Circle",
  polygon: "Polygon", star: "Star", north: "North arrow", section: "Section", level: "Level",
  line: "Line", poly: "Shape", block: "Block", double_arrow: "Double arrow", round_rect: "Rounded rectangle",
  triangle: "Triangle", diamond: "Diamond", pentagon: "Pentagon", hexagon: "Hexagon", block_arrow: "Solid arrow",
  smiley: "Smiley", heart: "Heart", tick: "Tick", cross: "Cross", speech: "Speech bubble", cloud_shape: "Cloud"
};

const K = 0.5522847498;

/* ---------- path helpers (commands: ['M',x,y] ['L',x,y] ['C',x1,y1,x2,y2,x,y] ['Z']) ---------- */

function ellipse(cx, cy, rx, ry) {
  const ox = rx * K, oy = ry * K;
  return [
    ["M", cx, cy - ry],
    ["C", cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy],
    ["C", cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry],
    ["C", cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy],
    ["C", cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry],
    ["Z"]
  ];
}

function polyCmds(pts, closed) {
  const out = [["M", pts[0], pts[1]]];
  for (let i = 2; i < pts.length; i += 2) out.push(["L", pts[i], pts[i + 1]]);
  if (closed) out.push(["Z"]);
  return out;
}

export function smoothCmds(pts) {
  const n = pts.length / 2;
  if (n < 3) return n === 2 ? polyCmds(pts, false) : [["M", pts[0], pts[1]], ["L", pts[0] + 0.01, pts[1]]];
  const out = [["M", pts[0], pts[1]]];
  let px = pts[0], py = pts[1];
  for (let i = 1; i < n - 1; i++) {
    const qx = pts[2 * i], qy = pts[2 * i + 1];
    const mx = (qx + pts[2 * i + 2]) / 2, my = (qy + pts[2 * i + 3]) / 2;
    out.push(["C", px + (2 / 3) * (qx - px), py + (2 / 3) * (qy - py), mx + (2 / 3) * (qx - mx), my + (2 / 3) * (qy - my), mx, my]);
    px = mx; py = my;
  }
  out.push(["L", pts[2 * n - 2], pts[2 * n - 1]]);
  return out;
}

// Light smoothing of the raw finger points (moving average), keeping the ends.
export function smoothPoints(pts, passes = 2) {
  let a = pts.slice();
  const n = a.length / 2;
  if (n < 5) return a;
  for (let p = 0; p < passes; p++) {
    const b = a.slice();
    for (let i = 1; i < n - 1; i++) {
      b[2 * i] = (a[2 * i - 2] + 2 * a[2 * i] + a[2 * i + 2]) / 4;
      b[2 * i + 1] = (a[2 * i - 1] + 2 * a[2 * i + 1] + a[2 * i + 3]) / 4;
    }
    a = b;
  }
  return a;
}

// Drop points closer than tol to the previous kept point.
export function thinPoints(pts, tol) {
  if (pts.length <= 4) return pts.slice();
  const out = [pts[0], pts[1]];
  for (let i = 2; i < pts.length - 2; i += 2) {
    if (Math.hypot(pts[i] - out[out.length - 2], pts[i + 1] - out[out.length - 1]) >= tol) out.push(pts[i], pts[i + 1]);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}

// If a stroke is nearly straight, return just its two ends.
export function straighten(pts) {
  const n = pts.length / 2;
  if (n < 3) return null;
  const ax = pts[0], ay = pts[1], bx = pts[2 * n - 2], by = pts[2 * n - 1];
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1e-6) return null;
  let maxd = 0;
  for (let i = 1; i < n - 1; i++) {
    const d = Math.abs((bx - ax) * (ay - pts[2 * i + 1]) - (ax - pts[2 * i]) * (by - ay)) / len;
    if (d > maxd) maxd = d;
  }
  return maxd < len * 0.035 ? [ax, ay, bx, by] : null;
}

// Revision cloud along a closed outline: scallops that bulge outward.
export function cloudCmds(pts, radius) {
  let P = pts.slice();
  const n0 = P.length / 2;
  if (n0 < 3) return polyCmds(P, true);
  let area = 0;
  for (let i = 0; i < n0; i++) {
    const j = (i + 1) % n0;
    area += P[2 * i] * P[2 * j + 1] - P[2 * j] * P[2 * i + 1];
  }
  if (area < 0) {
    const r = [];
    for (let i = n0 - 1; i >= 0; i--) r.push(P[2 * i], P[2 * i + 1]);
    P = r;
  }
  const segs = [];
  let per = 0;
  for (let i = 0; i < n0; i++) {
    const j = (i + 1) % n0;
    const l = Math.hypot(P[2 * j] - P[2 * i], P[2 * j + 1] - P[2 * i + 1]);
    segs.push(l);
    per += l;
  }
  const count = Math.max(6, Math.round(per / (radius * 1.8)));
  const step = per / count;
  const samples = [];
  let seg = 0, along = 0;
  for (let k = 0; k < count; k++) {
    let d = k * step;
    seg = 0; along = d;
    while (seg < n0 - 1 && along > segs[seg]) { along -= segs[seg]; seg++; }
    const j = (seg + 1) % n0;
    const t = segs[seg] ? along / segs[seg] : 0;
    samples.push(P[2 * seg] + (P[2 * j] - P[2 * seg]) * t, P[2 * seg + 1] + (P[2 * j + 1] - P[2 * seg + 1]) * t);
  }
  const out = [["M", samples[0], samples[1]]];
  for (let k = 0; k < count; k++) {
    const ax = samples[2 * k], ay = samples[2 * k + 1];
    const b = (k + 1) % count;
    const bx = samples[2 * b], by = samples[2 * b + 1];
    const cl = Math.hypot(bx - ax, by - ay) || 1;
    const tx = (bx - ax) / cl, ty = (by - ay) / cl;
    const nx = ty, ny = -tx;
    const hgt = cl * 0.5 * (4 / 3) * 0.85;
    out.push(["C", ax + nx * hgt, ay + ny * hgt, bx + nx * hgt, by + ny * hgt, bx, by]);
  }
  out.push(["Z"]);
  return out;
}

/* ---------- drawables ---------- */
// A drawable is { paths: [{cmds, stroke, w, fill, fillOpacity, opacity, multiply}], texts: [...] }

function headFilled(tipx, tipy, dx, dy, size, color) {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  const bx = tipx - ux * size, by = tipy - uy * size;
  const px = -uy * size * 0.45, py = ux * size * 0.45;
  return { cmds: [["M", tipx, tipy], ["L", bx + px, by + py], ["L", bx - px, by - py], ["Z"]], fill: color, fillOpacity: 1 };
}

function headOpen(tipx, tipy, dx, dy, size, color, w) {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  const bx = tipx - ux * size, by = tipy - uy * size;
  const px = -uy * size * 0.5, py = ux * size * 0.5;
  return { cmds: [["M", bx + px, by + py], ["L", tipx, tipy], ["L", bx - px, by - py]], stroke: color, w };
}

function textBlock(text, cx, cy, size, color, anchor = "middle") {
  const lines = String(text || "").split("\n");
  const lh = size * 1.18;
  const top = cy - ((lines.length - 1) * lh) / 2;
  return lines.map((t, i) => ({ text: t, x: cx, y: top + i * lh, size, color, anchor, baseline: "middle" }));
}

// Block: local millimetres (x right, y down, 0,0 at the top-left of its w x d box) -> base units.
export function blockMatrix(it) {
  const a = ((it.rot || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const k = it.k;
  return mul([c, s, -s, c, it.x1, it.y1], [k * (it.flip ? -1 : 1), 0, 0, k, -k * (it.flip ? -1 : 1) * it.bw / 2, -k * it.bd / 2]);
}

function xfCmds(cmds, m) {
  return cmds.map((c) => {
    if (c[0] === "Z") return c;
    const o = [c[0]];
    for (let i = 1; i < c.length; i += 2) { const q = apply(m, c[i], c[i + 1]); o.push(q[0], q[1]); }
    return o;
  });
}

function blockDrawable(it) {
  const m = blockMatrix(it);
  const paths = [], texts = [];
  const color = it.color, w = it.w;
  const fill = it.fill === true ? "#FFFFFF" : it.fill || "";
  if (fill) paths.push({ cmds: xfCmds(polyCmds([0, 0, it.bw, 0, it.bw, it.bd, 0, it.bd], true), m), fill, fillOpacity: it.fa == null ? 1 : it.fa });
  const dashOn = Math.max(110 * it.k, w * 3), dashOff = Math.max(75 * it.k, w * 2);
  for (const part of blockParts(it.family, it.bw, it.bd, it.p)) {
    if (part.text) {
      const q = apply(m, part.x, part.y);
      texts.push({ text: part.text, x: q[0], y: q[1], size: part.size * it.k, color, anchor: "middle", baseline: "middle", rot: it.rot || 0 });
      continue;
    }
    const path = { cmds: xfCmds(part.cmds, m), stroke: color, w };
    if (part.fill) { path.fill = "#FFFFFF"; path.fillOpacity = 1; }
    if (part.dash) path.dash = [dashOn, dashOff];
    paths.push(path);
  }
  return { paths, texts };
}

/** The fill colour of a shape ("" for none). Older items said fill: true for a light fill of the line colour. */
export function fillOf(it) {
  if (it.fill === true) return it.color;
  return typeof it.fill === "string" ? it.fill : "";
}
export function fillOpacityOf(it) {
  if (it.fa != null) return it.fa;
  return it.fill === true ? 0.18 : 1;
}

/** A box shape's frame: centre, size and turn (it.rot, degrees clockwise). */
export function shapeFrame(it) {
  const cx = (it.x1 + it.x2) / 2, cy = (it.y1 + it.y2) / 2;
  const a = ((it.rot || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { cx, cy, w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1), a, m: [c, s, -s, c, cx, cy] };
}

/** The bend point of a curved arrow (kept on the item once it has been moved). */
export function curveControl(it) {
  if (it.qx != null && it.qy != null) return [it.qx, it.qy];
  const dx = it.x2 - it.x1, dy = it.y2 - it.y1;
  const len = Math.hypot(dx, dy) || 1;
  return [(it.x1 + it.x2) / 2 + (dy / len) * len * 0.28, (it.y1 + it.y2) / 2 - (dx / len) * len * 0.28];
}

const CAPS = { 0: "butt", 1: "round", 2: "square" };

function partsToDrawable(parts, texts, m, rotDeg, opacity) {
  const paths = [];
  for (const p of parts) {
    const cmds = [];
    for (const sub of p.subs) cmds.push(...xfCmds(sub, m));
    const path = { cmds };
    if (p.mode === "F" || p.mode === "B") { path.fill = p.fill; path.fillOpacity = p.fa == null ? 1 : p.fa; }
    if (p.mode === "S" || p.mode === "B") {
      path.stroke = p.stroke; path.w = p.w; path.cap = CAPS[p.cap] || "round";
      if (p.join === 0) path.join = "miter";
      if (p.dash) path.dash = p.dash;
    }
    if (opacity != null && opacity < 0.999) path.opacity = opacity;
    paths.push(path);
  }
  const outTexts = [];
  for (const t of texts) {
    for (const ln of layoutText(t)) {
      const q = apply(m, ln.x, ln.y);
      outTexts.push({ text: ln.text, x: q[0], y: q[1], size: ln.size, color: ln.color, anchor: ln.anchor, baseline: "middle", bold: ln.bold, rot: rotDeg || 0, opacity });
    }
  }
  return { paths, texts: outTexts };
}

/** How a shape item is drawn (base units). pt: base units per PDF point on its page. */
export function shapeDrawable(it, unit, pt = 1) {
  if (it.shape === "block") return blockDrawable(it);
  const opacity = it.opacity == null ? 1 : it.opacity;
  const style = {
    color: it.color, w: it.w, dashed: !!it.dashed, hs: it.hs || 0, fill: fillOf(it), fa: fillOpacityOf(it),
    label: it.shape === "section" && it.text2 ? `${it.text || ""}\n${it.text2}` : it.text || "", ls: it.ls || 0, sides: it.sides || 6
  };
  if (LINE_KINDS.has(it.shape)) {
    const pts = it.shape === "curved" ? [[it.x1, it.y1], curveControl(it), [it.x2, it.y2]] : [[it.x1, it.y1], [it.x2, it.y2]];
    return partsToDrawable(lineParts(it.shape, pts, style, pt), [], [1, 0, 0, 1, 0, 0], 0, opacity);
  }
  if (it.shape === "poly") {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i < it.pts.length; i += 2) {
      b.x0 = Math.min(b.x0, it.pts[i]); b.x1 = Math.max(b.x1, it.pts[i]);
      b.y0 = Math.min(b.y0, it.pts[i + 1]); b.y1 = Math.max(b.y1, it.pts[i + 1]);
    }
    const w = Math.max(b.x1 - b.x0, 1e-6), h = Math.max(b.y1 - b.y0, 1e-6);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    style.upts = [];
    for (let i = 0; i < it.pts.length; i += 2) style.upts.push([(it.pts[i] - cx) / w, (it.pts[i + 1] - cy) / h]);
    const { parts, texts } = boxParts("poly", w, h, style, pt);
    return partsToDrawable(parts, texts, [1, 0, 0, 1, cx, cy], 0, opacity);
  }
  const f = shapeFrame(it);
  const { parts, texts } = boxParts(BOX_KINDS.has(it.shape) ? it.shape : "rect", f.w, f.h, style, pt);
  return partsToDrawable(parts, texts, f.m, it.rot || 0, opacity);
}

export function inkDrawable(it) {
  const k = PEN_KIND[it.pen] || PEN_KIND.pen;
  // strokes from the Windows app are drawn as they are there: straight between their points
  const cmds = it.pts.length === 4 || it.poly ? polyCmds(it.pts, false) : smoothCmds(it.pts);
  const opacity = it.opacity == null ? k.opacity : it.opacity;
  return { paths: [{ cmds, stroke: it.color, w: it.w, opacity, multiply: !!k.multiply, cap: it.pen === "highlighter" ? "square" : "round" }], texts: [] };
}

export function commentDrawable(it, unit) {
  const color = it.color;
  const w = it.w || unit * 0.0018;
  const paths = [];
  const texts = [];
  const cr = unit * 0.008;
  if (it.ctype === "box") {
    const pts = [it.x0, it.y0, it.x1, it.y0, it.x1, it.y1, it.x0, it.y1];
    paths.push({ cmds: it.cloud ? cloudCmds(pts, cr) : polyCmds(pts, true), stroke: color, w, fill: color, fillOpacity: 0.06 });
  } else if (it.ctype === "free") {
    paths.push({ cmds: it.cloud ? cloudCmds(it.pts, cr) : polyCmds(it.pts, true), stroke: color, w, fill: color, fillOpacity: 0.06 });
  } else if (it.ctype === "leader") {
    const { ax, ay, tx, ty, tw, th } = it;
    const ex = Math.max(tx, Math.min(ax, tx + tw)), ey = Math.max(ty, Math.min(ay, ty + th));
    let sx = ex, sy = ey;
    if (ax >= tx && ax <= tx + tw && ay >= ty && ay <= ty + th) { sx = tx; sy = ty + th / 2; }
    paths.push({ cmds: [["M", sx, sy], ["L", ax, ay]], stroke: color, w });
    paths.push(headOpen(ax, ay, ax - sx, ay - sy, Math.max(w * 6, unit * 0.01), color, w));
    paths.push({ cmds: polyCmds([tx, ty, tx + tw, ty, tx + tw, ty + th, tx, ty + th], true), stroke: color, w: w * 0.8, fill: "#FFFFFF", fillOpacity: 1 });
    const pad = it.fs * 0.35;
    const lines = String(it.text || "").split("\n");
    lines.forEach((t, i) => texts.push({ text: t, x: tx + pad, y: ty + pad + it.fs * (0.5 + i * 1.2), size: it.fs, color, anchor: "start", baseline: "middle" }));
  }
  return { paths, texts };
}

// The point where a comment's pin sits (box and freehand), in base units.
export function commentAnchor(it) {
  if (it.ctype === "box") return [Math.max(it.x0, it.x1), Math.min(it.y0, it.y1)];
  if (it.ctype === "free") {
    let mx = -Infinity, my = Infinity;
    for (let i = 0; i < it.pts.length; i += 2) {
      if (it.pts[i] > mx) mx = it.pts[i];
      if (it.pts[i + 1] < my) my = it.pts[i + 1];
    }
    return [mx, my];
  }
  return [it.tx + it.tw, it.ty];
}

// Bounding box of any item (base units), used for selection and hit tests.
export function itemBounds(it, unit, pt = 1) {
  let pts;
  if (it.kind === "ink") pts = it.pts;
  else if (it.kind === "blur") pts = [it.x0, it.y0, it.x1, it.y1];
  else if (it.kind === "comment") {
    if (it.ctype === "box") pts = [it.x0, it.y0, it.x1, it.y1];
    else if (it.ctype === "free") pts = it.pts;
    else pts = [it.ax, it.ay, it.tx, it.ty, it.tx + it.tw, it.ty + it.th];
  } else {
    const d = shapeDrawable(it, unit, pt);
    pts = [];
    for (const p of d.paths) for (const c of p.cmds) for (let i = 1; i < c.length; i += 2) pts.push(c[i], c[i + 1]);
    for (const t of d.texts) pts.push(t.x - t.size, t.y - t.size, t.x + t.size, t.y + t.size);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]); y0 = Math.min(y0, pts[i + 1]);
    x1 = Math.max(x1, pts[i]); y1 = Math.max(y1, pts[i + 1]);
  }
  const pad = (it.w || 0) / 2;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

export function drawableFor(it, unit, pt = 1) {
  if (it.kind === "ink") return inkDrawable(it);
  if (it.kind === "shape") return shapeDrawable(it, unit, pt);
  if (it.kind === "comment") return commentDrawable(it, unit);
  return { paths: [], texts: [] };
}

/* ---------- SVG output ---------- */

const f = (n) => (Math.round(n * 100) / 100).toString();

export function cmdsToSVG(cmds) {
  return cmds.map((c) => c[0] + (c.length > 1 ? c.slice(1).map(f).join(" ") : "")).join("");
}

function escXML(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function drawableToSVG(d, extraAttrs = "") {
  let out = "";
  for (const p of d.paths) {
    const attrs = [`d="${cmdsToSVG(p.cmds)}"`];
    if (p.fill) attrs.push(`fill="${p.fill}"`, `fill-opacity="${p.fillOpacity ?? 1}"`);
    else attrs.push('fill="none"');
    if (p.stroke) attrs.push(`stroke="${p.stroke}"`, `stroke-width="${f(p.w)}"`, `stroke-linecap="${p.cap || "round"}"`, `stroke-linejoin="${p.join || "round"}"`);
    if (p.stroke && p.dash) attrs.push(`stroke-dasharray="${f(p.dash[0])} ${f(p.dash[1])}"`);
    if (p.opacity != null && p.opacity < 1) attrs.push(`opacity="${p.opacity}"`);
    if (p.multiply) attrs.push('style="mix-blend-mode:multiply"');
    out += `<path ${attrs.join(" ")}${extraAttrs}/>`;
  }
  for (const t of d.texts) {
    const anchor = t.anchor === "start" ? "start" : t.anchor === "end" ? "end" : "middle";
    const turn = t.rot ? ` transform="rotate(${f(t.rot)} ${f(t.x)} ${f(t.y)})"` : "";
    const op = t.opacity != null && t.opacity < 0.999 ? ` opacity="${t.opacity}"` : "";
    out += `<text x="${f(t.x)}" y="${f(t.y)}" font-size="${f(t.size)}" fill="${t.color}" text-anchor="${anchor}" dominant-baseline="central" font-family="Arial, Helvetica, sans-serif"${t.bold ? ' font-weight="700"' : ""}${turn}${op}>${escXML(t.text)}</text>`;
  }
  return out;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
