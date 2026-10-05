// Shapes drawn exactly like the Windows app draws them (its drawings.py), so a shape looks the
// same on the phone and on the computer, whichever of the two made it.
// Everything here is in the shape's own coordinates: a box w x h centred on 0,0, y going down,
// in base units. `pt` is the length of one PDF point in base units (the Windows app's sizes that
// are not relative to the shape - default text size, the smallest arrow head - are in points).
//
// Output: { parts: [{ subs, mode: "S"|"F"|"B", stroke, fill, w, cap, join, dash, fa }],
//           texts: [{ text, size, bold, box: [x0, y0, x1, y1], align: "l"|"c"|"r", valign: "t"|"m"|"b", color }] }

const K = 0.5522847498;
export const TEXT_COLOR = "#1F2328";

export const LINE_KINDS = new Set(["line", "arrow", "double_arrow", "curved"]);
export const BOX_KINDS = new Set(["rect", "round_rect", "circle", "triangle", "diamond", "pentagon", "hexagon", "poly",
  "polygon", "block_arrow", "star", "smiley", "heart", "tick", "cross", "speech", "cloud_shape", "north", "section", "level"]);
export const LABEL_KINDS = new Set([...BOX_KINDS].filter((k) => !["tick", "cross", "north", "smiley"].includes(k)));
export const CLOSED_KINDS = new Set(["rect", "round_rect", "circle", "triangle", "diamond", "pentagon", "hexagon", "poly",
  "polygon", "block_arrow", "star", "heart", "speech", "cloud_shape", "smiley"]);

function ellipse(cx, cy, rx, ry) {
  const k = K;
  return [["M", cx + rx, cy],
    ["C", cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry],
    ["C", cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy],
    ["C", cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry],
    ["C", cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy], ["Z"]];
}

export function polyOps(points, closed = true) {
  const ops = [["M", points[0][0], points[0][1]]];
  for (let i = 1; i < points.length; i++) ops.push(["L", points[i][0], points[i][1]]);
  if (closed) ops.push(["Z"]);
  return ops;
}

function fit(points, w, h) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const sx = w / ((x1 - x0) || 1), sy = h / ((y1 - y0) || 1);
  return points.map(([x, y]) => [(x - x0) * sx - w / 2, (y - y0) * sy - h / 2]);
}

function regular(n, startDeg) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = ((startDeg + (360 * i) / n) * Math.PI) / 180;
    out.push([Math.cos(a), Math.sin(a)]);
  }
  return out;
}

function star(w, h) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 1 : 0.42;
    const a = ((-90 + 36 * i) * Math.PI) / 180;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return fit(pts, w, h);
}

function roundRect(x0, y0, x1, y1, r) {
  r = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  const k = K * r;
  return [["M", x0 + r, y0], ["L", x1 - r, y0], ["C", x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r],
    ["L", x1, y1 - r], ["C", x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1],
    ["L", x0 + r, y1], ["C", x0 + r - k, y1, x0, y1 - r + k, x0, y1 - r],
    ["L", x0, y0 + r], ["C", x0, y0 + r - k, x0 + r - k, y0, x0 + r, y0], ["Z"]];
}

function cloud(w, h, pt) {
  const n = Math.max(8, Math.round((Math.PI * (w + h) / 2) / Math.max(6 * pt, Math.min(w, h) / 3.5)));
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([(w / 2) * 0.86 * Math.cos((2 * Math.PI * i) / n), (h / 2) * 0.86 * Math.sin((2 * Math.PI * i) / n)]);
  const ops = [["M", pts[0][0], pts[0][1]]];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const cx = b[0] - a[0], cy = b[1] - a[1];
    const ln = Math.hypot(cx, cy) || 1e-9;
    let nx = cy / ln, ny = -cx / ln;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny; }
    const hh = 0.6 * ln;
    ops.push(["C", a[0] + nx * hh, a[1] + ny * hh, b[0] + nx * hh, b[1] + ny * hh, b[0], b[1]]);
  }
  ops.push(["Z"]);
  return ops;
}

function heart(w, h) {
  const pts = [];
  for (let i = 0; i < 72; i++) {
    const t = (2 * Math.PI * i) / 72;
    pts.push([16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
  }
  return polyOps(fit(pts, w, h));
}

function speech(w, h) {
  const bh = h * 0.78;
  const x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = -h / 2 + bh;
  const r = Math.min(w, bh) * 0.18;
  const k = K * r;
  const tx = x0 + w * 0.22;
  return [["M", x0 + r, y0], ["L", x1 - r, y0], ["C", x1 - r + k, y0, x1, y0 + r - k, x1, y0 + r],
    ["L", x1, y1 - r], ["C", x1, y1 - r + k, x1 - r + k, y1, x1 - r, y1],
    ["L", tx + w * 0.16, y1], ["L", tx - w * 0.04, h / 2], ["L", tx, y1],
    ["L", x0 + r, y1], ["C", x0 + r - k, y1, x0, y1 - r + k, x0, y1 - r],
    ["L", x0, y0 + r], ["C", x0, y0 + r - k, x0 + r - k, y0, x0 + r, y0], ["Z"]];
}

function blockArrow(w, h) {
  const hw = Math.min(w * 0.45, h * 0.95);
  return polyOps([[-w / 2, -h / 4], [w / 2 - hw, -h / 4], [w / 2 - hw, -h / 2], [w / 2, 0],
    [w / 2 - hw, h / 2], [w / 2 - hw, h / 4], [-w / 2, h / 4]]);
}

function arrowHead(tip, frm, size, closed) {
  const ang = Math.atan2(tip[1] - frm[1], tip[0] - frm[0]);
  const a1 = ang + Math.PI - 0.42, a2 = ang + Math.PI + 0.42;
  const p1 = [tip[0] + size * Math.cos(a1), tip[1] + size * Math.sin(a1)];
  const p2 = [tip[0] + size * Math.cos(a2), tip[1] + size * Math.sin(a2)];
  if (closed) return polyOps([p1, tip, p2]);
  return [["M", p1[0], p1[1]], ["L", tip[0], tip[1]], ["L", p2[0], p2[1]]];
}

export function quadToCubic(p0, c, p1) {
  return [[p0[0] + (2 / 3) * (c[0] - p0[0]), p0[1] + (2 / 3) * (c[1] - p0[1])],
    [p1[0] + (2 / 3) * (c[0] - p1[0]), p1[1] + (2 / 3) * (c[1] - p1[1])]];
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function textColorFor(stroke) {
  const [r, g, b] = hexToRgb(stroke);
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.72 ? TEXT_COLOR : stroke;
}

const P = (subs, mode, stroke, fill, w, cap = 1, join = 1, dash = null, fa = 1) => ({ subs, mode, stroke, fill, w, cap, join, dash, fa });

/**
 * A line kind: pts = [p0, p1] or [p0, control, p1] (curved), in base units.
 * s: { color, w, dashed, hs }.
 */
export function lineParts(kind, pts, s, pt = 1) {
  const dash = s.dashed ? [s.w * 3, s.w * 2.2] : null;
  const hs = s.hs || Math.max(6 * pt, s.w * 4.5);
  const parts = [];
  if (kind === "curved" && pts.length >= 3) {
    const [p0, c, p1] = pts;
    const [c1, c2] = quadToCubic(p0, c, p1);
    parts.push(P([[["M", ...p0], ["C", ...c1, ...c2, ...p1]]], "S", s.color, "", s.w, 1, 1, dash));
    parts.push(P([arrowHead(p1, c, hs, true)], "B", s.color, s.color, s.w, 1, 1));
    return parts;
  }
  const p0 = pts[0], p1 = pts[pts.length - 1];
  parts.push(P([polyOps([p0, p1], false)], "S", s.color, "", s.w, 1, 1, dash));
  if (kind === "arrow" || kind === "double_arrow") parts.push(P([arrowHead(p1, p0, hs, false)], "S", s.color, "", s.w, 1, 1));
  if (kind === "double_arrow") parts.push(P([arrowHead(p0, p1, hs, false)], "S", s.color, "", s.w, 1, 1));
  return parts;
}

/**
 * A box kind, w x h centred on 0,0. s: { color, w, fill, fa, dashed, label, ls, sides, upts }
 * upts: the corners of a free polygon in the unit box (-0.5 .. 0.5).
 */
export function boxParts(kind, w, h, s, pt = 1) {
  w = Math.max(w, 1e-6); h = Math.max(h, 1e-6);
  const x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
  const fill = s.fill || "";
  const mode = fill ? "B" : "S";
  const dash = s.dashed ? [s.w * 3, s.w * 2.2] : null;
  const fa = s.fa == null ? 1 : s.fa;
  const main = (subs, join = 1) => P(subs, mode, s.color, fill, s.w, 1, join, dash, fa);
  const parts = [];
  const texts = [];
  const tc = textColorFor(s.color);
  const label = s.label || "";
  switch (kind) {
    case "rect": parts.push(main([polyOps([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])], 0)); break;
    case "round_rect": parts.push(main([roundRect(x0, y0, x1, y1, Math.min(w, h) * 0.2)])); break;
    case "circle": parts.push(main([ellipse(0, 0, w / 2, h / 2)])); break;
    case "triangle": parts.push(main([polyOps([[0, y0], [x1, y1], [x0, y1]])])); break;
    case "poly": {
      const pts = (s.upts && s.upts.length >= 3 ? s.upts : [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5]]).map(([u, v]) => [u * w, v * h]);
      parts.push(main([polyOps(pts)]));
      break;
    }
    case "diamond": parts.push(main([polyOps([[0, y0], [x1, 0], [0, y1], [x0, 0]])])); break;
    case "pentagon": parts.push(main([polyOps(fit(regular(5, -90), w, h))])); break;
    case "hexagon": parts.push(main([polyOps([[x0, 0], [x0 + w / 4, y0], [x1 - w / 4, y0], [x1, 0], [x1 - w / 4, y1], [x0 + w / 4, y1]])])); break;
    case "polygon": {
      const n = Math.max(3, Math.min(12, Math.round(s.sides || 6)));
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
        pts.push([(w / 2) * Math.cos(a), (h / 2) * Math.sin(a)]);
      }
      parts.push(main([polyOps(pts)]));
      break;
    }
    case "block_arrow": parts.push(main([blockArrow(w, h)])); break;
    case "star": parts.push(main([polyOps(star(w, h))])); break;
    case "heart": parts.push(main([heart(w, h)])); break;
    case "speech": parts.push(main([speech(w, h)])); break;
    case "cloud_shape": parts.push(main([cloud(w, h, pt)])); break;
    case "tick": parts.push(P([polyOps([[x0, y0 + h * 0.55], [x0 + w * 0.35, y1], [x1, y0]], false)], "S", s.color, "", s.w)); break;
    case "cross": parts.push(P([polyOps([[x0, y0], [x1, y1]], false), polyOps([[x1, y0], [x0, y1]], false)], "S", s.color, "", s.w)); break;
    case "smiley": {
      const r = Math.min(w, h) / 2, sx = w / 2 / r, sy = h / 2 / r, eye = r * 0.11;
      parts.push(main([ellipse(0, 0, w / 2, h / 2)]));
      parts.push(P([ellipse(-0.36 * r * sx, -0.25 * r * sy, eye * sx, eye * sy), ellipse(0.36 * r * sx, -0.25 * r * sy, eye * sx, eye * sy)], "F", "", s.color, s.w));
      const mouth = [];
      for (let i = 0; i <= 16; i++) {
        const a = ((20 + (140 * i) / 16) * Math.PI) / 180;
        mouth.push([0.55 * r * sx * Math.cos(a), 0.55 * r * sy * Math.sin(a)]);
      }
      parts.push(P([polyOps(mouth, false)], "S", s.color, "", s.w));
      break;
    }
    case "north": {
      const r = Math.min(w, h * 0.78) / 2;
      const cy = y1 - r;
      parts.push(main([ellipse(0, cy, r, r)]));
      const needle = [[0, cy - r * 0.92], [r * 0.36, cy + r * 0.62], [0, cy + r * 0.32], [-r * 0.36, cy + r * 0.62]];
      parts.push(P([polyOps(needle)], "B", s.color, s.color, s.w * 0.6));
      const nh = Math.max(pt, cy - r - y0);
      texts.push({ text: "N", size: Math.min(nh * 0.95, r * 0.7), bold: true, box: [x0, y0, x1, y0 + nh], align: "c", valign: "b", color: s.color });
      return { parts, texts };
    }
    case "section": {
      const r = Math.min(h / 2, w * 0.36);
      const cx = x0 + r;
      parts.push(main([ellipse(cx, 0, r, r)]));
      parts.push(P([polyOps([[x0, 0], [cx + r, 0]], false)], "S", s.color, "", s.w));
      parts.push(P([polyOps([[cx + r * 0.7, -r * 0.7], [x1, 0], [cx + r * 0.7, r * 0.7]])], "B", s.color, s.color, s.w));
      if (label) {
        const i = label.indexOf("\n");
        const first = i < 0 ? label : label.slice(0, i);
        const second = i < 0 ? "" : label.slice(i + 1).trim();
        const fs = s.ls || r * 0.75;
        if (first) texts.push({ text: first, size: fs, bold: true, box: [cx - r * 0.8, -r * 0.92, cx + r * 0.8, -r * 0.08], align: "c", valign: "m", color: tc });
        if (second) texts.push({ text: second, size: fs * 0.75, bold: false, box: [cx - r * 0.8, r * 0.08, cx + r * 0.8, r * 0.92], align: "c", valign: "m", color: tc });
      }
      return { parts, texts };
    }
    case "level": {
      const triW = Math.min(w * 0.3, h * 0.9);
      const lineY = y1 - s.w;
      parts.push(P([polyOps([[x0, lineY - triW * 0.7], [x0 + triW, lineY - triW * 0.7], [x0 + triW / 2, lineY]])], "B", s.color, s.color, s.w));
      parts.push(P([polyOps([[x0, lineY], [x1, lineY]], false)], "S", s.color, "", s.w));
      if (label) {
        const fs = s.ls || Math.max(4 * pt, (lineY - y0) * 0.75);
        texts.push({ text: label, size: fs, bold: false, box: [x0 + triW * 1.15, y0, x1, lineY - s.w * 1.5], align: "l", valign: "b", color: tc });
      }
      return { parts, texts };
    }
    default:
      parts.push(main([polyOps([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])], 0));
  }
  if (label && LABEL_KINDS.has(kind)) {
    const pad = (x1 - x0) * 0.08;
    texts.push({ text: label, size: s.ls || 10 * pt, bold: false, box: [x0 + pad, y0 + pad, x1 - pad, y1 - pad], align: "c", valign: "m", color: tc });
  }
  return { parts, texts };
}

/* ---------- text: wrapped the way the Windows app wraps it ---------- */

let mctx = null;
function measure(text, size, bold) {
  if (!mctx) mctx = new OffscreenCanvas(8, 8).getContext("2d");
  mctx.font = `${bold ? 700 : 400} 100px Arial, Helvetica, sans-serif`;
  return (mctx.measureText(text).width * size) / 100;
}

export function wrapText(text, size, bold, maxW) {
  const lines = [];
  for (const para of String(text || "").split("\n")) {
    let cur = "";
    for (const word of para.split(" ")) {
      const t = cur ? cur + " " + word : word;
      if (!cur || measure(t, size, bold) <= maxW) { cur = t; continue; }
      lines.push(cur);
      cur = word;
    }
    while (cur && measure(cur, size, bold) > maxW && cur.length > 1) {
      let n = cur.length;
      while (n > 1 && measure(cur.slice(0, n), size, bold) > maxW) n--;
      lines.push(cur.slice(0, n));
      cur = cur.slice(n);
    }
    lines.push(cur);
  }
  return lines;
}

/** Text lines laid out in a box (local coordinates): [{ text, x, y (centre of the line), size, bold, anchor, color }]. */
export function layoutText(t) {
  const [x0, y0, x1, y1] = t.box;
  const lines = wrapText(t.text, t.size, t.bold, Math.max(1e-6, x1 - x0));
  const lh = t.size * 1.22;
  const total = lh * lines.length;
  const top = t.valign === "t" ? y0 : t.valign === "b" ? y1 - total : (y0 + y1) / 2 - total / 2;
  const out = [];
  lines.forEach((ln, i) => {
    if (!ln) return;
    const y = top + i * lh + lh / 2;
    let x = (x0 + x1) / 2, anchor = "middle";
    if (t.align === "l") { x = x0; anchor = "start"; }
    else if (t.align === "r") { x = x1; anchor = "end"; }
    out.push({ text: ln, x, y, size: t.size, bold: t.bold, anchor, color: t.color });
  });
  return out;
}
