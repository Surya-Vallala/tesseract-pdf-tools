// Picture work for the built-in scanner (used in Chrome; the Android app uses Google's scanner):
// finding the page in a photo, straightening it, and cleaning it up.
// Everything works on plain pixel arrays so it runs the same anywhere.

/* ---------- finding the page ---------- */

/**
 * Guesses the four corners of a sheet of paper in a photo.
 * rgba: pixels (Uint8ClampedArray), w x h. Returns [tl, tr, br, bl] as {x, y} in those pixels, or null.
 */
export function findPage(rgba, w, h) {
  // Work on a small grey copy.
  const S = 320;
  const k = Math.min(1, S / Math.max(w, h));
  const sw = Math.max(8, Math.round(w * k));
  const sh = Math.max(8, Math.round(h * k));
  let g = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    const y0 = Math.floor(y / k), y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) / k)));
    for (let x = 0; x < sw; x++) {
      const x0 = Math.floor(x / k), x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) / k)));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 2) {
        for (let xx = x0; xx < x1; xx += 2) {
          const i = (yy * w + xx) * 4;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          n++;
        }
      }
      g[y * sw + x] = n ? sum / n : 0;
    }
  }
  g = boxBlur(boxBlur(g, sw, sh, 2), sw, sh, 2);

  // Paper is usually the brightest large area: split light from dark.
  const t = otsu(g);
  const mask = new Uint8Array(sw * sh);
  for (let i = 0; i < mask.length; i++) mask[i] = g[i] > t ? 1 : 0;

  // The biggest light patch.
  const label = new Int32Array(sw * sh).fill(-1);
  let best = -1, bestSize = 0;
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    let size = 0;
    label[start] = start;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop();
      size++;
      const x = p % sw, y = (p - x) / sw;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) { label[p - 1] = start; stack.push(p - 1); }
      if (x < sw - 1 && mask[p + 1] && label[p + 1] < 0) { label[p + 1] = start; stack.push(p + 1); }
      if (y > 0 && mask[p - sw] && label[p - sw] < 0) { label[p - sw] = start; stack.push(p - sw); }
      if (y < sh - 1 && mask[p + sw] && label[p + sw] < 0) { label[p + sw] = start; stack.push(p + sw); }
    }
    if (size > bestSize) { bestSize = size; best = start; }
  }
  const frac = bestSize / (sw * sh);
  if (best < 0 || frac < 0.12 || frac > 0.96) return null;

  // Its outline, then the four-cornered shape that covers most of it.
  const pts = [];
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const p = y * sw + x;
      if (label[p] !== best) continue;
      const edge = x === 0 || y === 0 || x === sw - 1 || y === sh - 1 ||
        label[p - 1] !== best || label[p + 1] !== best || label[p - sw] !== best || label[p + sw] !== best;
      if (edge) pts.push({ x: x + 0.5, y: y + 0.5 });
    }
  }
  let hull = convexHull(pts);
  hull = simplify(hull, 1.5);
  if (hull.length > 48) hull = hull.filter((_, i) => i % Math.ceil(hull.length / 48) === 0);
  if (hull.length < 4) return null;
  const quad = largestQuad(hull);
  if (!quad) return null;
  const qa = Math.abs(polyArea(quad));
  if (qa < bestSize * 0.8 || qa > bestSize * 1.25) return null; // not paper-shaped
  return orderCorners(quad.map((p) => ({ x: p.x / k, y: p.y / k })));
}

/** Puts four points in order: top-left, top-right, bottom-right, bottom-left. */
export function orderCorners(pts) {
  const c = pts.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  // atan2 order starting from the left goes: top-left, top-right, bottom-right, bottom-left (y down)
  let start = 0, bestSum = Infinity;
  sorted.forEach((p, i) => { if (p.x + p.y < bestSum) { bestSum = p.x + p.y; start = i; } });
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1);
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function otsu(g) {
  const hist = new Float64Array(256);
  for (const v of g) hist[Math.max(0, Math.min(255, v | 0))]++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; t = i; }
  }
  return t;
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// Drops outline points that barely change its shape.
function simplify(poly, eps) {
  if (poly.length < 5) return poly;
  const keep = poly.filter((p, i) => {
    const a = poly[(i - 1 + poly.length) % poly.length];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const d = Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
    return d > eps;
  });
  return keep.length >= 4 ? keep : poly;
}

function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return a / 2;
}

function largestQuad(hull) {
  const n = hull.length;
  let best = null, bestA = 0;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          const q = [hull[a], hull[b], hull[c], hull[d]];
          const ar = Math.abs(polyArea(q));
          if (ar > bestA) { bestA = ar; best = q; }
        }
      }
    }
  }
  return best;
}

/* ---------- straightening ---------- */

// The 3x3 map that takes the output rectangle (0,0)-(W,H) onto the four corners in the photo.
function homography(W, H, q) {
  const src = [[0, 0], [W, 0], [W, H], [0, H]];
  const A = [];
  const B = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const { x: u, y: v } = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
  }
  const s = solve(A, B);
  return s ? [...s, 1] : null;
}

function solve(A, B) {
  const n = B.length;
  const M = A.map((r, i) => [...r, B[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** How big the straightened page should be (pixels), from the corner positions. */
export function outputSize(q, maxLong = 2200) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let W = Math.max(d(q[0], q[1]), d(q[3], q[2]));
  let H = Math.max(d(q[0], q[3]), d(q[1], q[2]));
  // A photo taken at an angle makes the page look shorter than it is. Most sheets here are
  // A-sizes (A4, A3), so a shape close to that is taken to be exactly that.
  const r = Math.max(W, H) / Math.min(W, H);
  if (r > 1.18 && r < 1.66) {
    if (H >= W) H = W * Math.SQRT2; else W = H * Math.SQRT2;
  }
  const k = Math.min(1, maxLong / Math.max(W, H));
  W = Math.max(16, Math.round(W * k));
  H = Math.max(16, Math.round(H * k));
  return { W, H };
}

/** Straightens the part of the photo inside the four corners into a W x H picture. */
export function straighten(rgba, w, h, q, W, H) {
  const m = homography(W, H, q);
  const out = new Uint8ClampedArray(W * H * 4);
  if (!m) return out;
  const [a, b, c, d, e, f, g, hh] = m;
  let o = 0;
  for (let y = 0; y < H; y++) {
    const yy = y + 0.5;
    for (let x = 0; x < W; x++) {
      const xx = x + 0.5;
      const z = g * xx + hh * yy + 1;
      let u = (a * xx + b * yy + c) / z - 0.5;
      let v = (d * xx + e * yy + f) / z - 0.5;
      if (u < 0) u = 0; else if (u > w - 1.001) u = w - 1.001;
      if (v < 0) v = 0; else if (v > h - 1.001) v = h - 1.001;
      const x0 = u | 0, y0 = v | 0;
      const fx = u - x0, fy = v - y0;
      const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = rgba[i00 + ch] + (rgba[i10 + ch] - rgba[i00 + ch]) * fx;
        const bot = rgba[i01 + ch] + (rgba[i11 + ch] - rgba[i01 + ch]) * fx;
        out[o + ch] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
      o += 4;
    }
  }
  return out;
}

/* ---------- cleaning up ---------- */

/**
 * mode "clean": paper turns white and ink stays, in colour (stamps and signatures keep their colour).
 * mode "bw": the same, in black and white.
 * mode "original": unchanged.
 */
export function cleanUp(px, W, H, mode) {
  if (mode === "original") return px;
  // How bright the paper is around each spot: the brightest nearby values, smoothed.
  const B = 24;
  const bw = Math.ceil(W / B), bh = Math.ceil(H / B);
  let bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const vals = [];
      for (let y = by * B; y < Math.min(H, (by + 1) * B); y += 3) {
        for (let x = bx * B; x < Math.min(W, (bx + 1) * B); x += 3) {
          const i = (y * W + x) * 4;
          vals.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
        }
      }
      vals.sort((p, q) => q - p);
      bg[by * bw + bx] = vals[Math.floor(vals.length * 0.1)] || 255; // ignore a few hot pixels
    }
  }
  // Spread the brightest neighbours over text blocks, then smooth.
  bg = maxFilter(bg, bw, bh, 1);
  bg = boxBlur(bg, bw, bh, 1);
  const out = new Uint8ClampedArray(px.length);
  const black = 0.28, white = 0.88;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(bh - 1.001, Math.max(0, (y + 0.5) / B - 0.5));
    const y0 = fy | 0, ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(bw - 1.001, Math.max(0, (x + 0.5) / B - 0.5));
      const x0 = fx | 0, tx = fx - x0;
      const b00 = bg[y0 * bw + x0], b10 = bg[y0 * bw + x0 + 1], b01 = bg[(y0 + 1) * bw + x0], b11 = bg[(y0 + 1) * bw + x0 + 1];
      const paper = Math.max(40, (b00 + (b10 - b00) * tx) * (1 - ty) + (b01 + (b11 - b01) * tx) * ty);
      const i = (y * W + x) * 4;
      if (mode === "bw") {
        const l = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / paper;
        const v = 255 * curve((l - black) / (white - black));
        out[i] = out[i + 1] = out[i + 2] = v;
      } else {
        for (let ch = 0; ch < 3; ch++) out[i + ch] = 255 * curve((px[i + ch] / paper - black) / (white - black));
      }
      out[i + 3] = 255;
    }
  }
  return out;
}

const curve = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t) * 0.35 + t * 0.65);

function maxFilter(src, w, h, r) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const v = src[yy * w + Math.min(w - 1, Math.max(0, x + dx))];
          if (v > m) m = v;
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}
