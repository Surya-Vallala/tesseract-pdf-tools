// Page geometry. Every mark the user makes is stored in "base" units: the page as it is
// in the file, before any rotation or crop (points for PDF pages, pixels for photos,
// y going down from the top-left). These helpers map base units to what is shown.
import { FULL, imagePlacement, imagePageSize } from "./doc.js";

// Affine matrix [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f
export const I = [1, 0, 0, 1, 0, 0];

// mul(m1, m2): apply m2 first, then m1.
export function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}
export function inv(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export const T = (x, y) => [1, 0, 0, 1, x, y];
export const S = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];

// Clockwise rotation of content that is w x h, keeping it in the positive quadrant.
export function rot(R, w, h) {
  switch (R) {
    case 90: return [0, 1, -1, 0, h, 0];
    case 180: return [-1, 0, 0, -1, w, h];
    case 270: return [0, -1, 1, 0, 0, w];
    default: return I.slice();
  }
}

/**
 * Geometry of a page as shown:
 *  W, H: base size; R: total rotation; dw, dh: the shown page size (points);
 *  b2d: base -> shown page coordinates; unit: base length used to size pens and text.
 */
export function pageGeom(doc, p) {
  const s = doc.src(p);
  const { W, H, R } = doc.base(p);
  const c = p.crop || FULL;
  const cw = (c.x1 - c.x0) * W;
  const ch = (c.y1 - c.y0) * H;
  const turned = R % 180 === 90;
  const rw = turned ? ch : cw;
  const rh = turned ? cw : ch;
  const toContent = mul(rot(R, cw, ch), T(-c.x0 * W, -c.y0 * H));
  if (s.kind === "image") {
    const ps = imagePageSize(rw, rh, doc.imageFit);
    const place = imagePlacement(ps, rw, rh);
    const k = place.w / rw;
    const b2d = mul(T(place.x, place.y), mul(S(k), toContent));
    return { W, H, R, crop: c, dw: ps.w, dh: ps.h, b2d, unit: Math.min(W, H), place, k };
  }
  return { W, H, R, crop: c, dw: rw, dh: rh, b2d: toContent, unit: Math.min(W, H), place: null, k: 1 };
}

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

export function distToPolyline(px, py, pts, closed = false) {
  let best = Infinity;
  const n = pts.length / 2;
  if (n === 1) return Math.hypot(px - pts[0], py - pts[1]);
  for (let i = 0; i < n - 1; i++) {
    best = Math.min(best, distToSeg(px, py, pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], pts[2 * i + 3]));
  }
  if (closed && n > 2) best = Math.min(best, distToSeg(px, py, pts[2 * n - 2], pts[2 * n - 1], pts[0], pts[1]));
  return best;
}
