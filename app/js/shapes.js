// Geometry of marks (pen strokes, shapes, comments) in base units.
// The same description is drawn on screen (SVG) and written into the PDF, so they match.

import { blockParts } from "./blocks.js";
import { mul, apply } from "./geom.js";

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
  line: "Line", poly: "Shape", block: "Block"
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
  if (it.fill) paths.push({ cmds: xfCmds(polyCmds([0, 0, it.bw, 0, it.bw, it.bd, 0, it.bd], true), m), fill: "#FFFFFF", fillOpacity: 1 });
  const dashOn = Math.max(110 * it.k, w * 3), dashOff = Math.max(75 * it.k, w * 2);
  for (const part of blockParts(it.family, it.bw, it.bd, it.p)) {
    if (part.text) {
      const q = apply(m, part.x, part.y);
      texts.push({ text: part.text, x: q[0], y: q[1], size: part.size * it.k, color, anchor: "middle", baseline: "middle" });
      continue;
    }
    const path = { cmds: xfCmds(part.cmds, m), stroke: color, w };
    if (part.fill) { path.fill = "#FFFFFF"; path.fillOpacity = 1; }
    if (part.dash) path.dash = [dashOn, dashOff];
    paths.push(path);
  }
  return { paths, texts };
}

export function shapeDrawable(it, unit) {
  if (it.shape === "block") return blockDrawable(it);
  const { x1, y1, x2, y2, color } = it;
  const w = it.w;
  const fill = it.fill ? color : null;
  const paths = [];
  const texts = [];
  const bx0 = Math.min(x1, x2), by0 = Math.min(y1, y2), bx1 = Math.max(x1, x2), by1 = Math.max(y1, y2);
  const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
  const bw = bx1 - bx0, bh = by1 - by0;
  const tsize = Math.max(unit * 0.008, Math.min(unit * 0.04, Math.min(bw, bh) * 0.26));
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  switch (it.shape) {
    case "arrow": {
      const hs = Math.min(len * 0.4, Math.max(w * 5, unit * 0.012));
      const ux = len ? dx / len : 1, uy = len ? dy / len : 0;
      paths.push({ cmds: [["M", x1, y1], ["L", x2 - ux * hs * 0.9, y2 - uy * hs * 0.9]], stroke: color, w });
      paths.push(headFilled(x2, y2, dx, dy, hs, color));
      if (it.text) texts.push(...textBlock(it.text, x1, y1 - tsize, tsize, color));
      break;
    }
    case "curved": {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const qx = mx + (dy / (len || 1)) * len * 0.3, qy = my - (dx / (len || 1)) * len * 0.3;
      const hs = Math.min(len * 0.4, Math.max(w * 5, unit * 0.012));
      const tdx = x2 - qx, tdy = y2 - qy;
      const tl = Math.hypot(tdx, tdy) || 1;
      const ex = x2 - (tdx / tl) * hs * 0.9, ey = y2 - (tdy / tl) * hs * 0.9;
      paths.push({ cmds: [["M", x1, y1], ["C", x1 + (2 / 3) * (qx - x1), y1 + (2 / 3) * (qy - y1), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey]], stroke: color, w });
      paths.push(headFilled(x2, y2, tdx, tdy, hs, color));
      if (it.text) texts.push(...textBlock(it.text, x1, y1 - tsize, tsize, color));
      break;
    }
    case "line":
      paths.push({ cmds: [["M", x1, y1], ["L", x2, y2]], stroke: color, w });
      break;
    case "poly":
      paths.push({ cmds: polyCmds(it.pts, true), stroke: color, w, fill, fillOpacity: 0.18 });
      break;
    case "rect":
      paths.push({ cmds: polyCmds([bx0, by0, bx1, by0, bx1, by1, bx0, by1], true), stroke: color, w, fill, fillOpacity: 0.18 });
      if (it.text) texts.push(...textBlock(it.text, cx, cy, tsize, color));
      break;
    case "circle":
      paths.push({ cmds: ellipse(cx, cy, bw / 2, bh / 2), stroke: color, w, fill, fillOpacity: 0.18 });
      if (it.text) texts.push(...textBlock(it.text, cx, cy, tsize, color));
      break;
    case "polygon": {
      const n = Math.max(3, Math.min(12, it.sides || 6));
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        pts.push(cx + (bw / 2) * Math.cos(a), cy + (bh / 2) * Math.sin(a));
      }
      paths.push({ cmds: polyCmds(pts, true), stroke: color, w, fill, fillOpacity: 0.18 });
      if (it.text) texts.push(...textBlock(it.text, cx, cy, tsize * 0.85, color));
      break;
    }
    case "star": {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.45 : 1;
        pts.push(cx + (bw / 2) * r * Math.cos(a), cy + (bh / 2) * r * Math.sin(a));
      }
      paths.push({ cmds: polyCmds(pts, true), stroke: color, w, fill, fillOpacity: 0.18 });
      if (it.text) texts.push(...textBlock(it.text, cx, cy, tsize * 0.7, color));
      break;
    }
    case "north": {
      const r = Math.max(len / 2, unit * 0.01);
      const ux = len ? dx / len : 0, uy = len ? dy / len : -1;
      const ox = (x1 + x2) / 2, oy = (y1 + y2) / 2;
      const L = (u, v) => [ox + ux * u * r - uy * v * r, oy + uy * u * r + ux * v * r];
      paths.push({ cmds: ellipse(ox, oy, r, r), stroke: color, w });
      const t = L(0.92, 0), bl = L(-0.62, 0.42), nc = L(-0.3, 0), br = L(-0.62, -0.42);
      paths.push({ cmds: [["M", ...t], ["L", ...bl], ["L", ...nc], ["Z"]], stroke: color, w: w * 0.8, fill: color, fillOpacity: 1 });
      paths.push({ cmds: [["M", ...t], ["L", ...br], ["L", ...nc], ["Z"]], stroke: color, w: w * 0.8 });
      const np = L(1.3, 0);
      texts.push({ text: it.text || "N", x: np[0], y: np[1], size: r * 0.42, color, anchor: "middle", baseline: "middle", bold: true });
      break;
    }
    case "section": {
      const r = Math.max(unit * 0.012, Math.min(len * 0.45, unit * 0.05));
      const ux = len ? dx / len : 1, uy = len ? dy / len : 0;
      const tip = [x1 + ux * r * 1.7, y1 + uy * r * 1.7];
      const pa = [x1 - uy * r * 0.98, y1 + ux * r * 0.98], pb = [x1 + uy * r * 0.98, y1 - ux * r * 0.98];
      paths.push({ cmds: [["M", ...tip], ["L", ...pa], ["L", ...pb], ["Z"]], fill: color, fillOpacity: 1 });
      paths.push({ cmds: ellipse(x1, y1, r, r), stroke: color, w, fill: "#FFFFFF", fillOpacity: 1 });
      paths.push({ cmds: [["M", x1 - r, y1], ["L", x1 + r, y1]], stroke: color, w });
      texts.push({ text: it.text || "A", x: x1, y: y1 - r * 0.45, size: r * 0.55, color, anchor: "middle", baseline: "middle", bold: true });
      if (it.text2) texts.push({ text: it.text2, x: x1, y: y1 + r * 0.45, size: r * 0.4, color, anchor: "middle", baseline: "middle" });
      break;
    }
    case "level": {
      const s = Math.max(w * 3, unit * 0.006);
      const xEnd = Math.abs(dx) > s * 3 ? x2 : x1 + s * 12;
      paths.push({ cmds: [["M", Math.min(x1 - s * 2, xEnd), y1], ["L", Math.max(x1 + s * 2, xEnd), y1]], stroke: color, w });
      paths.push({ cmds: [["M", x1 - s, y1 - s * 1.7], ["L", x1 + s, y1 - s * 1.7], ["L", x1, y1], ["Z"]], stroke: color, w: w * 0.8, fill: color, fillOpacity: 1 });
      texts.push({ text: it.text || "+0.00", x: x1 + s * 1.8, y: y1 - s * 0.95, size: s * 1.9, color, anchor: "start", baseline: "middle" });
      break;
    }
  }
  return { paths, texts };
}

export function inkDrawable(it) {
  const k = PEN_KIND[it.pen] || PEN_KIND.pen;
  const cmds = it.pts.length === 4 ? polyCmds(it.pts, false) : smoothCmds(it.pts);
  return { paths: [{ cmds, stroke: it.color, w: it.w, opacity: k.opacity, multiply: !!k.multiply, cap: it.pen === "highlighter" ? "butt" : "round" }], texts: [] };
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
export function itemBounds(it, unit) {
  let pts;
  if (it.kind === "ink") pts = it.pts;
  else if (it.kind === "blur") pts = [it.x0, it.y0, it.x1, it.y1];
  else if (it.kind === "comment") {
    if (it.ctype === "box") pts = [it.x0, it.y0, it.x1, it.y1];
    else if (it.ctype === "free") pts = it.pts;
    else pts = [it.ax, it.ay, it.tx, it.ty, it.tx + it.tw, it.ty + it.th];
  } else {
    const d = shapeDrawable(it, unit);
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

export function drawableFor(it, unit) {
  if (it.kind === "ink") return inkDrawable(it);
  if (it.kind === "shape") return shapeDrawable(it, unit);
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
    if (p.stroke) attrs.push(`stroke="${p.stroke}"`, `stroke-width="${f(p.w)}"`, `stroke-linecap="${p.cap || "round"}"`, 'stroke-linejoin="round"');
    if (p.stroke && p.dash) attrs.push(`stroke-dasharray="${f(p.dash[0])} ${f(p.dash[1])}"`);
    if (p.opacity != null && p.opacity < 1) attrs.push(`opacity="${p.opacity}"`);
    if (p.multiply) attrs.push('style="mix-blend-mode:multiply"');
    out += `<path ${attrs.join(" ")}${extraAttrs}/>`;
  }
  for (const t of d.texts) {
    out += `<text x="${f(t.x)}" y="${f(t.y)}" font-size="${f(t.size)}" fill="${t.color}" text-anchor="${t.anchor === "start" ? "start" : "middle"}" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif"${t.bold ? ' font-weight="700"' : ""}>${escXML(t.text)}</text>`;
  }
  return out;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
