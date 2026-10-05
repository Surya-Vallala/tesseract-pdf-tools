// Hold-to-snap: turns a rough stroke into a clean shape.
// Input: flat [x, y, ...] points in base units. Output, or null if it isn't a clear shape:
//   { shape: "line" | "arrow", x1, y1, x2, y2 }
//   { shape: "rect" | "circle", x1, y1, x2, y2 }   (an axis-aligned box; circle means ellipse)
//   { shape: "poly", pts }                            (closed, straight sides)

const DEG = Math.PI / 180;

function pathLength(P) {
  let L = 0;
  for (let i = 2; i < P.length; i += 2) L += Math.hypot(P[i] - P[i - 2], P[i + 1] - P[i - 1]);
  return L;
}

// n points evenly spaced along the path (closed adds the segment back to the start).
function resample(P, n, closed) {
  const pts = closed ? [...P, P[0], P[1]] : P;
  const L = pathLength(pts);
  if (!L) return null;
  const step = L / (closed ? n : n - 1);
  const out = [pts[0], pts[1]];
  let acc = 0, i = 2, px = pts[0], py = pts[1];
  while (out.length < 2 * n && i < pts.length) {
    const qx = pts[i], qy = pts[i + 1];
    const d = Math.hypot(qx - px, qy - py);
    if (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      px = px + (qx - px) * t;
      py = py + (qy - py) * t;
      out.push(px, py);
      acc = 0;
    } else {
      acc += d;
      px = qx; py = qy;
      i += 2;
    }
  }
  while (out.length < 2 * n) out.push(pts[pts.length - 2], pts[pts.length - 1]);
  if (closed) out.length = 2 * n;
  return out;
}

function maxDevFromChord(P, i0, i1) {
  const ax = P[2 * i0], ay = P[2 * i0 + 1], bx = P[2 * i1], by = P[2 * i1 + 1];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  let m = 0;
  for (let i = i0 + 1; i < i1; i++) {
    const d = Math.abs((bx - ax) * (ay - P[2 * i + 1]) - (ax - P[2 * i]) * (by - ay)) / len;
    if (d > m) m = d;
  }
  return m;
}

// Snap a direction to horizontal / vertical (and 45°) when close.
function snapEnd(x1, y1, x2, y2) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  let a = Math.atan2(y2 - y1, x2 - x1);
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  const e = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
  if (Math.abs(a - q) < 7 * DEG) a = q;
  else if (Math.abs(a - e) < 4 * DEG) a = e;
  return [x1 + len * Math.cos(a), y1 + len * Math.sin(a)];
}

function openShape(P) {
  const n = P.length / 2;
  const L = pathLength(P);
  const x1 = P[0], y1 = P[1], x2 = P[2 * n - 2], y2 = P[2 * n - 1];
  const chord = Math.hypot(x2 - x1, y2 - y1);
  // A straight line.
  if (chord > 0 && L < chord * 1.25 && maxDevFromChord(P, 0, n - 1) < chord * 0.07) {
    const [ex, ey] = snapEnd(x1, y1, x2, y2);
    return { shape: "line", x1, y1, x2: ex, y2: ey };
  }
  // An arrow drawn in one stroke: a straight shaft out to the tip, then a short head near the tip.
  let tip = 0, best = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(P[2 * i] - x1, P[2 * i + 1] - y1);
    if (d > best) { best = d; tip = i; }
  }
  if (tip > 2 && tip < n - 2) {
    const shaft = best;
    const tx = P[2 * tip], ty = P[2 * tip + 1];
    const shaftPath = pathLength(P.slice(0, 2 * tip + 2));
    const tail = pathLength(P.slice(2 * tip));
    let far = 0;
    for (let i = tip; i < n; i++) far = Math.max(far, Math.hypot(P[2 * i] - tx, P[2 * i + 1] - ty));
    if (shaftPath < shaft * 1.2 && maxDevFromChord(P, 0, tip) < shaft * 0.08 &&
        tail > shaft * 0.06 && tail < shaft * 0.9 && far < shaft * 0.4) {
      const [ex, ey] = snapEnd(x1, y1, tx, ty);
      return { shape: "arrow", x1, y1, x2: ex, y2: ey };
    }
  }
  return null;
}

// Turning angle at each sample of a closed loop, over a window of k samples either side.
function turning(R, k) {
  const n = R.length / 2;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - k + n) % n, b = (i + k) % n;
    const ux = R[2 * i] - R[2 * a], uy = R[2 * i + 1] - R[2 * a + 1];
    const vx = R[2 * b] - R[2 * i], vy = R[2 * b + 1] - R[2 * i + 1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (!lu || !lv) { out[i] = 0; continue; }
    const c = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
    out[i] = Math.acos(c);
  }
  return out;
}

function corners(R) {
  const n = R.length / 2;
  const k = 3;
  const t = turning(R, k);
  const found = [];
  for (let i = 0; i < n; i++) {
    if (t[i] < 50 * DEG) continue;
    let isMax = true;
    for (let j = -k; j <= k; j++) {
      if (!j) continue;
      const v = t[(i + j + n) % n];
      if (v > t[i] || (v === t[i] && j < 0)) { isMax = false; break; }
    }
    if (isMax) found.push(i);
  }
  return found;
}

// Where two lines (each through a corner and fitted to its neighbouring sides) meet would be
// more exact, but the sample at the sharpest turn is close enough once sides are straightened.
function cornerPoints(R, idx) {
  return idx.flatMap((i) => [R[2 * i], R[2 * i + 1]]);
}

function ellipseFit(R) {
  const n = R.length / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, R[2 * i]); x1 = Math.max(x1, R[2 * i]);
    y0 = Math.min(y0, R[2 * i + 1]); y1 = Math.max(y1, R[2 * i + 1]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2 || 1, ry = (y1 - y0) / 2 || 1;
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const r = Math.hypot((R[2 * i] - cx) / rx, (R[2 * i + 1] - cy) / ry);
    s += r; s2 += r * r;
  }
  const mean = s / n;
  const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean)) / mean;
  return { x0, y0, x1, y1, cx, cy, rx, ry, sd };
}

function angleAt(pts, i) {
  const n = pts.length / 2;
  const a = (i - 1 + n) % n, b = (i + 1) % n;
  const ux = pts[2 * a] - pts[2 * i], uy = pts[2 * a + 1] - pts[2 * i + 1];
  const vx = pts[2 * b] - pts[2 * i], vy = pts[2 * b + 1] - pts[2 * i + 1];
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1))));
}

function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, cx, cy) * o(ax, ay, bx, by, dx, dy) < 0 && o(cx, cy, dx, dy, ax, ay) * o(cx, cy, dx, dy, bx, by) < 0;
}
function selfCrossing(C) {
  const m = C.length / 2;
  for (let i = 0; i < m; i++) {
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue;
      const i2 = (i + 1) % m, j2 = (j + 1) % m;
      if (segsCross(C[2 * i], C[2 * i + 1], C[2 * i2], C[2 * i2 + 1], C[2 * j], C[2 * j + 1], C[2 * j2], C[2 * j2 + 1])) return true;
    }
  }
  return false;
}

function quad(C) {
  // A rectangle if every corner is close to square.
  for (let i = 0; i < 4; i++) if (Math.abs(angleAt(C, i) - Math.PI / 2) > 22 * DEG) return { shape: "poly", pts: C };
  // Orientation: average of the side directions, folded into 0..90°.
  let sx = 0, sy = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const a = Math.atan2(C[2 * j + 1] - C[2 * i + 1], C[2 * j] - C[2 * i]);
    sx += Math.cos(4 * a); sy += Math.sin(4 * a);
  }
  let th = Math.atan2(sy, sx) / 4;
  const cx = (C[0] + C[2] + C[4] + C[6]) / 4, cy = (C[1] + C[3] + C[5] + C[7]) / 4;
  if (Math.abs(th) < 10 * DEG) th = 0;
  // Half sizes along the two directions.
  const ux = Math.cos(th), uy = Math.sin(th), vx = -uy, vy = ux;
  let hu = 0, hv = 0;
  for (let i = 0; i < 4; i++) {
    hu += Math.abs((C[2 * i] - cx) * ux + (C[2 * i + 1] - cy) * uy);
    hv += Math.abs((C[2 * i] - cx) * vx + (C[2 * i + 1] - cy) * vy);
  }
  hu /= 4; hv /= 4;
  if (th === 0) return { shape: "rect", x1: cx - hu, y1: cy - hv, x2: cx + hu, y2: cy + hv };
  const pt = (a, b) => [cx + ux * a + vx * b, cy + uy * a + vy * b];
  return { shape: "poly", pts: [...pt(-hu, -hv), ...pt(hu, -hv), ...pt(hu, hv), ...pt(-hu, hv)] };
}

function closedShape(P, diag) {
  // Cut an overshoot: the end that runs back past the start.
  const n = P.length / 2;
  let cut = n - 1, bestD = Infinity;
  for (let i = Math.floor(n * 0.7); i < n; i++) {
    const d = Math.hypot(P[2 * i] - P[0], P[2 * i + 1] - P[1]);
    if (d < bestD) { bestD = d; cut = i; }
  }
  const loop = P.slice(0, 2 * cut + 2);
  const R = resample(loop, 64, true);
  if (!R) return null;
  const e = ellipseFit(R);
  const idx = corners(R);
  if ((idx.length <= 2 && e.sd < 0.16) || e.sd < 0.06) {
    let { x0, y0, x1, y1 } = e;
    const w = x1 - x0, h = y1 - y0;
    if (w / h > 0.82 && w / h < 1.22) {
      const r = (w + h) / 4;
      x0 = e.cx - r; x1 = e.cx + r; y0 = e.cy - r; y1 = e.cy + r;
    }
    return { shape: "circle", x1: x0, y1: y0, x2: x1, y2: y1 };
  }
  if (idx.length < 3 || idx.length > 10) return null;
  const C = cornerPoints(R, idx);
  if (selfCrossing(C)) return null;
  // Sides must be reasonably straight: the samples between corners stay near the chord.
  for (let c = 0; c < idx.length; c++) {
    const a = idx[c], b = idx[(c + 1) % idx.length];
    const ax = R[2 * a], ay = R[2 * a + 1], bx = R[2 * b], by = R[2 * b + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = (a + 1) % 64; i !== b; i = (i + 1) % 64) {
      const d = Math.abs((bx - ax) * (ay - R[2 * i + 1]) - (ax - R[2 * i]) * (by - ay)) / len;
      if (d > Math.max(len * 0.14, diag * 0.04)) return null;
    }
  }
  if (idx.length === 4) return quad(C);
  // Straighten sides that are nearly horizontal or vertical by evening out their ends.
  const m = C.length / 2;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const a = Math.atan2(C[2 * j + 1] - C[2 * i + 1], C[2 * j] - C[2 * i]);
    const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(a - q) < 6 * DEG) {
      if (Math.abs(Math.sin(q)) < 0.5) { const y = (C[2 * i + 1] + C[2 * j + 1]) / 2; C[2 * i + 1] = y; C[2 * j + 1] = y; }
      else { const x = (C[2 * i] + C[2 * j]) / 2; C[2 * i] = x; C[2 * j] = x; }
    }
  }
  return { shape: "poly", pts: C };
}

export function recognizeShape(pts) {
  const n = pts.length / 2;
  if (n < 5) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, pts[2 * i]); x1 = Math.max(x1, pts[2 * i]);
    y0 = Math.min(y0, pts[2 * i + 1]); y1 = Math.max(y1, pts[2 * i + 1]);
  }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  if (!diag) return null;
  const L = pathLength(pts);
  const gap = Math.hypot(pts[2 * n - 2] - pts[0], pts[2 * n - 1] - pts[1]);
  const closed = gap < diag * 0.25 && L > diag * 1.8;
  return closed ? closedShape(pts, diag) : openShape(pts);
}
