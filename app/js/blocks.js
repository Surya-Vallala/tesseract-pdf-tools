// Architecture blocks: plan symbols drawn at real size, in millimetres.
// Each block draws into a w × d box (x to the right, y down). The back of the
// piece (wall side: headboard, sofa back, WC cistern, wardrobe back) is at the top, y = 0.
// Doors hinge at the top-left and swing down into the room.
// Output is a list of parts: { cmds, dash } with path commands
// ['M',x,y] ['L',x,y] ['C',x1,y1,x2,y2,x,y] ['Z'], or { text, x, y, size }.
// A part with fill: true is filled with paper white, to hide what is under it (chairs under a table).

const K = 0.5522847498;

/* ---------- path helpers ---------- */

function rect(x, y, w, h) {
  return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
}
function rrect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) return rect(x, y, w, h);
  const o = r * (1 - K);
  return [
    ["M", x + r, y], ["L", x + w - r, y], ["C", x + w - o, y, x + w, y + o, x + w, y + r],
    ["L", x + w, y + h - r], ["C", x + w, y + h - o, x + w - o, y + h, x + w - r, y + h],
    ["L", x + r, y + h], ["C", x + o, y + h, x, y + h - o, x, y + h - r],
    ["L", x, y + r], ["C", x, y + o, x + o, y, x + r, y], ["Z"]
  ];
}
function line(x1, y1, x2, y2) { return [["M", x1, y1], ["L", x2, y2]]; }
function poly(pts, closed) {
  const out = [["M", pts[0], pts[1]]];
  for (let i = 2; i < pts.length; i += 2) out.push(["L", pts[i], pts[i + 1]]);
  if (closed) out.push(["Z"]);
  return out;
}
function ellipse(cx, cy, rx, ry) {
  const ox = rx * K, oy = ry * K;
  return [
    ["M", cx, cy - ry], ["C", cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy],
    ["C", cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry], ["C", cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy],
    ["C", cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry], ["Z"]
  ];
}
function circle(cx, cy, r) { return ellipse(cx, cy, r, r); }
// Arc from angle a0 to a1 (radians, y down so positive angles turn clockwise on screen).
function arc(cx, cy, r, a0, a1, move = true) {
  const out = [];
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-9));
  const da = (a1 - a0) / n;
  const t = (4 / 3) * Math.tan(da / 4);
  let x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  if (move) out.push(["M", x0, y0]);
  for (let i = 0; i < n; i++) {
    const b0 = a0 + i * da, b1 = b0 + da;
    const x1 = cx + r * Math.cos(b1), y1 = cy + r * Math.sin(b1);
    out.push(["C", x0 - t * r * Math.sin(b0), y0 + t * r * Math.cos(b0), x1 + t * r * Math.sin(b1), y1 - t * r * Math.cos(b1), x1, y1]);
    x0 = x1; y0 = y1;
  }
  return out;
}
// Wavy outline for trees and shrubs: n bumps meeting on an inner circle.
function scallop(cx, cy, r, n) {
  const step = (2 * Math.PI) / n;
  const r0 = r * 0.84, rq = r * 1.12;
  const pt = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  let [x0, y0] = pt(r0, 0);
  const out = [["M", x0, y0]];
  for (let i = 0; i < n; i++) {
    const [qx, qy] = pt(rq, (i + 0.5) * step);
    const [x1, y1] = pt(r0, (i + 1) * step);
    out.push(["C", x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0), x1 + (2 / 3) * (qx - x1), y1 + (2 / 3) * (qy - y1), x1, y1]);
    x0 = x1; y0 = y1;
  }
  out.push(["Z"]);
  return out;
}

// Transform helper for drawing a sub-part rotated about a point.
function xf(cmds, m) {
  return cmds.map((c) => {
    if (c[0] === "Z") return c;
    const o = [c[0]];
    for (let i = 1; i < c.length; i += 2) o.push(m[0] * c[i] + m[2] * c[i + 1] + m[4], m[1] * c[i] + m[3] * c[i + 1] + m[5]);
    return o;
  });
}
function rotAbout(deg, cx, cy) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}

const P = (cmds, dash = false, fill = false) => ({ cmds, dash, fill });
const T = (text, x, y, size) => ({ text, x, y, size });

/* ---------- pieces used by several blocks ---------- */

// Dining chair, 450 square, back towards the top, placed with its centre at cx, cy and turned by deg.
function chair(cx, cy, deg, s = 450) {
  const parts = [rrect(-s / 2, -s / 2, s, s, 40), rrect(-s / 2 + 30, -s / 2 + 10, s - 60, 70, 30)];
  const m = rotAbout(deg, 0, 0);
  m[4] += cx; m[5] += cy;
  return parts.map((c) => P(xf(c, m)));
}

function burner(cx, cy, r) {
  return [P(circle(cx, cy, r)), P(circle(cx, cy, r * 0.55))];
}

/* ---------- the blocks ---------- */

const DOOR_LEAF = 40;

function singleDoor(w) {
  // hinge at (0,0); leaf open at 90°, along the left edge; swing arc from the open end back to the closed position.
  return [P(rect(0, 0, DOOR_LEAF, w)), P(arc(0, 0, w, Math.PI / 2, 0))];
}
function doubleDoor(w) {
  const h = w / 2;
  return [
    P(rect(0, 0, DOOR_LEAF, h)), P(arc(0, 0, h, Math.PI / 2, 0)),
    P(rect(w - DOOR_LEAF, 0, DOOR_LEAF, h)), P(arc(w, 0, h, Math.PI / 2, Math.PI))
  ];
}
function slidingDoor(w, d) {
  const pw = w / 2 + 40, t = 40;
  const y1 = d / 2 - t - 4, y2 = d / 2 + 4;
  return [
    P(line(0, 0, 0, d)), P(line(w, 0, w, d)),
    P(rect(0, y1, pw, t)), P(rect(w - pw, y2, pw, t)),
    P(poly([w * 0.18, y1 - 60, w * 0.32, y1 - 60])), P(poly([w * 0.29, y1 - 85, w * 0.32, y1 - 60, w * 0.29, y1 - 35])),
    P(poly([w * 0.82, y2 + t + 60, w * 0.68, y2 + t + 60])), P(poly([w * 0.71, y2 + t + 35, w * 0.68, y2 + t + 60, w * 0.71, y2 + t + 85]))
  ];
}
function windowBlock(w, d) {
  return [P(rect(0, 0, w, d)), P(line(0, d / 2 - 25, w, d / 2 - 25)), P(line(0, d / 2 + 25, w, d / 2 + 25))];
}
function slidingWindow(w, d) {
  const pw = w / 2 + 30;
  return [P(rect(0, 0, w, d)), P(line(0, d / 2 - 30, pw, d / 2 - 30)), P(line(w - pw, d / 2 + 30, w, d / 2 + 30))];
}
function ventilator(w, d) {
  return [P(rect(0, 0, w, d)), P(line(0, d / 2, w, d / 2)), P(line(0, 0, w, d))];
}

function bed(w, d, p = {}) {
  const head = 60;
  const parts = [P(rect(0, 0, w, d)), P(line(0, head, w, head))];
  const pillows = w >= 1200 ? 2 : 1;
  const m = 90, ph = 330;
  const pw = (w - m * (pillows + 1)) / pillows;
  for (let i = 0; i < pillows; i++) parts.push(P(rrect(m + i * (pw + m), head + 70, pw, ph, 70)));
  const fy = head + 70 + ph + 170;
  parts.push(P(line(0, fy, w, fy)));
  const f = Math.min(320, w * 0.3);
  parts.push(P(poly([w - f, fy, w, fy + f])));
  return parts;
}
function bedsideTable(w, d) {
  return [P(rect(0, 0, w, d)), P(circle(w / 2, d / 2, Math.min(w, d) * 0.27)), P(line(w / 2 - 50, d / 2, w / 2 + 50, d / 2)), P(line(w / 2, d / 2 - 50, w / 2, d / 2 + 50))];
}
function studyTable(w, d) {
  const td = 600;
  return [...chair(w * 0.36, td + 60, 180), P(rect(0, 0, w, td), false, true), P(rect(w - 450, 0, 400, td - 40))];
}
function dressingTable(w, d) {
  const td = 450;
  return [P(rect(0, 0, w, td)), P(line(80, 30, w - 80, 30)), P(circle(w / 2, td + 230, 190))];
}

function sofa(w, d, p = {}) {
  const arm = Math.min(170, w * 0.18), back = 190;
  const n = p.seats || Math.max(1, Math.round((w - 2 * arm) / 600));
  const parts = [P(rrect(0, 0, w, d, 50)), P(line(arm, back, w - arm, back)), P(line(arm, 0, arm, d)), P(line(w - arm, 0, w - arm, d))];
  const sw = (w - 2 * arm) / n;
  for (let i = 1; i < n; i++) parts.push(P(line(arm + i * sw, back, arm + i * sw, d)));
  for (let i = 0; i < n; i++) parts.push(P(rrect(arm + i * sw + 25, back + 25, sw - 50, d - back - 70, 50)));
  return parts;
}
function lSofa(w, d) {
  const sd = 850, arm = 160, back = 190;
  const outline = [
    ["M", 0, 0], ["L", w, 0], ["L", w, sd], ["L", sd, sd], ["L", sd, d], ["L", 0, d], ["Z"]
  ];
  const parts = [P(outline)];
  parts.push(P(poly([w - arm, 0, w - arm, sd])));
  parts.push(P(poly([0, d - arm, sd, d - arm])));
  parts.push(P(poly([back, d - arm, back, back, w - arm, back])));
  // seat divisions along the long run and the return
  const runA = w - arm - sd, nA = Math.max(1, Math.round(runA / 650));
  for (let i = 0; i <= nA; i++) parts.push(P(line(sd + (runA * i) / nA, back, sd + (runA * i) / nA, sd)));
  const runB = d - arm - sd, nB = Math.max(1, Math.round(runB / 650));
  for (let i = 1; i <= nB; i++) parts.push(P(line(back, sd + (runB * i) / nB, sd, sd + (runB * i) / nB)));
  parts.push(P(line(back, sd, sd, sd)));
  return parts;
}
function coffeeTable(w, d) {
  return [P(rrect(0, 0, w, d, 40)), P(rrect(60, 60, w - 120, d - 120, 20))];
}
function sideTable(w, d) {
  return [P(ellipse(w / 2, d / 2, w / 2, d / 2)), P(ellipse(w / 2, d / 2, w / 2 - 50, d / 2 - 50))];
}
function tvUnit(w, d) {
  const parts = [P(rect(0, 0, w, d))];
  const n = Math.max(2, Math.round(w / 600));
  for (let i = 1; i < n; i++) parts.push(P(line((w * i) / n, 0, (w * i) / n, d)));
  const tw = Math.min(1450, w - 200);
  parts.push(P(rect((w - tw) / 2, 30, tw, 70)), P(rect(w / 2 - 150, 100, 300, 60)));
  return parts;
}

function dining(w, d, p = {}) {
  // table in the middle, chairs tucked 100 under the table edge.
  const cd = 450 - 100;
  const tw = w - (p.ends ? 2 * cd : 0), th = d - 2 * cd;
  const tx = (w - tw) / 2, ty = cd;
  const parts = [];
  const side = p.side;
  for (let i = 0; i < side; i++) {
    const cx = tx + (tw * (i + 0.5)) / side;
    parts.push(...chair(cx, ty - cd + 225 - 0, 0));
    parts.push(...chair(cx, ty + th + cd - 225, 180));
  }
  if (p.ends) {
    parts.push(...chair(tx - cd + 225, ty + th / 2, -90));
    parts.push(...chair(tx + tw + cd - 225, ty + th / 2, 90));
  }
  parts.push(P(rect(tx, ty, tw, th), false, true));
  return parts;
}
function roundDining(w, d, p = {}) {
  const r = Math.min(w, d) / 2 - 350, cx = w / 2, cy = d / 2;
  const parts = [];
  const n = p.seats || 4;
  for (let i = 0; i < n; i++) {
    const a = (i * 360) / n - 90;
    const rad = (a * Math.PI) / 180;
    parts.push(...chair(cx + (r + 125) * Math.cos(rad), cy + (r + 125) * Math.sin(rad), a + 90));
  }
  parts.push(P(circle(cx, cy, r), false, true));
  return parts;
}

function hob(w, d, p = {}) {
  const n = p.burners || 3;
  const parts = [P(rrect(0, 0, w, d, 30))];
  if (n === 2) parts.push(...burner(w * 0.27, d / 2, d * 0.28), ...burner(w * 0.73, d / 2, d * 0.28));
  else if (n === 3) parts.push(...burner(w * 0.2, d * 0.62, d * 0.22), ...burner(w * 0.5, d * 0.38, d * 0.27), ...burner(w * 0.8, d * 0.62, d * 0.22));
  else parts.push(...burner(w * 0.28, d * 0.28, d * 0.17), ...burner(w * 0.72, d * 0.28, d * 0.2), ...burner(w * 0.28, d * 0.72, d * 0.2), ...burner(w * 0.72, d * 0.72, d * 0.17));
  return parts;
}
function chimney(w, d) {
  const iw = w * 0.36, id = d * 0.5;
  return [P(rect(0, 0, w, d), true), P(rect((w - iw) / 2, 0, iw, id), true), P(line(0, d, (w - iw) / 2, id), true), P(line(w, d, (w + iw) / 2, id), true)];
}
function sink(w, d, p = {}) {
  const parts = [P(rect(0, 0, w, d))];
  const m = 60;
  if (p.bowls === 2) {
    const bw = (w - 3 * m) / 2;
    parts.push(P(rrect(m, m + 40, bw, d - 2 * m - 40, 60)), P(rrect(2 * m + bw, m + 40, bw, d - 2 * m - 40, 60)));
    parts.push(P(circle(m + bw / 2, d / 2 + 20, 30)), P(circle(2 * m + bw * 1.5, d / 2 + 20, 30)));
    parts.push(P(circle(w / 2, 30, 18)));
  } else if (p.drain) {
    const bw = w * 0.5;
    parts.push(P(rrect(m, m + 40, bw, d - 2 * m - 40, 60)), P(circle(m + bw / 2, d / 2 + 20, 30)), P(circle(m + bw / 2, 30, 18)));
    const x0 = 2 * m + bw;
    for (let x = x0 + 40; x < w - m; x += 70) parts.push(P(line(x, m + 40, x, d - m)));
  } else {
    parts.push(P(rrect(m, m + 40, w - 2 * m, d - 2 * m - 40, 60)), P(circle(w / 2, d / 2 + 20, 30)), P(circle(w / 2, 30, 18)));
  }
  return parts;
}
function fridge(w, d, p = {}) {
  const parts = [P(rect(0, 0, w, d)), P(line(0, d - 60, w, d - 60))];
  if (p.doors === 2) parts.push(P(line(w / 2, d - 60, w / 2, d)));
  parts.push(T("REF", w / 2, d / 2 - 20, Math.min(w, d) * 0.22));
  return parts;
}
function dishwasher(w, d) {
  return [P(rect(0, 0, w, d)), P(line(0, d - 60, w, d - 60)), T("DW", w / 2, d / 2 - 20, Math.min(w, d) * 0.24)];
}
function washingMachine(w, d) {
  return [P(rect(0, 0, w, d)), P(line(0, 110, w, 110)), P(circle(w / 2, d / 2 + 50, Math.min(w, d) * 0.33)), P(circle(w / 2, d / 2 + 50, Math.min(w, d) * 0.22))];
}

function westernWC(w, d) {
  const ch = 190;
  const bw = Math.min(w, 380);
  return [
    P(rrect(0, 0, w, ch, 30)),
    P(ellipse(w / 2, ch + (d - ch) / 2, bw / 2, (d - ch) / 2)),
    P(ellipse(w / 2, ch + (d - ch) / 2 + 20, bw / 2 - 55, (d - ch) / 2 - 75)),
    P(line(w / 2 - 70, ch, w / 2 - 70, ch + 40)), P(line(w / 2 + 70, ch, w / 2 + 70, ch + 40))
  ];
}
function wallWC(w, d) {
  const plate = 60;
  return [
    P(rect(w / 2 - 230, 0, 460, plate)),
    P(ellipse(w / 2, plate + (d - plate) / 2, w / 2, (d - plate) / 2)),
    P(ellipse(w / 2, plate + (d - plate) / 2 + 15, w / 2 - 55, (d - plate) / 2 - 70))
  ];
}
function indianWC(w, d) {
  // squatting pan with foot rests; the narrow end (outlet) towards the top
  return [
    P(rrect(0, 0, w, d, 120)),
    P(ellipse(w / 2, d * 0.4, w * 0.2, d * 0.3)),
    P(rrect(w * 0.06, d * 0.58, w * 0.18, d * 0.3, 40)),
    P(rrect(w * 0.76, d * 0.58, w * 0.18, d * 0.3, 40))
  ];
}
function washbasin(w, d) {
  const back = 120;
  const outline = [["M", 0, 0], ["L", w, 0], ["L", w, back], ...arc(w / 2, back, w / 2, 0, Math.PI, false).map((c) => c), ["Z"]];
  // squash the front half-round to fit the depth
  const sy = (d - back) / (w / 2);
  const out = outline.map((c) => (c[0] === "C" ? ["C", c[1], back + (c[2] - back) * sy, c[3], back + (c[4] - back) * sy, c[5], back + (c[6] - back) * sy] : c));
  return [P(out), P(ellipse(w / 2, back + (d - back) * 0.38, w * 0.32, (d - back) * 0.45)), P(circle(w / 2, back + (d - back) * 0.38, 22)), P(circle(w / 2, back / 2 + 10, 20))];
}
function counterBasin(w, d) {
  return [P(rect(0, 0, w, d)), P(ellipse(w / 2, d / 2 + 20, Math.min(w * 0.3, 260), d * 0.3)), P(circle(w / 2, d / 2 + 20, 22)), P(circle(w / 2, 50, 20))];
}
function shower(w, d) {
  return [P(rect(0, 0, w, d)), P(line(0, 0, w, d)), P(line(w, 0, 0, d)), P(circle(w / 2, d / 2, 45)), P(circle(w - 120, 90, 55)), P(line(w - 120, 0, w - 120, 35))];
}
function bathtub(w, d) {
  return [P(rect(0, 0, w, d)), P(rrect(70, 70, w - 140, d - 140, Math.min(220, (d - 140) / 2))), P(circle(w - 220, d / 2, 35)), P(circle(w - 70 - 40, d / 2, 18))];
}

function wardrobe(w, d) {
  const parts = [P(rect(0, 0, w, d))];
  const doors = Math.max(1, Math.round(w / 600));
  for (let i = 1; i < doors; i++) parts.push(P(line((w * i) / doors, d - 70, (w * i) / doors, d)));
  parts.push(P(line(0, d - 70, w, d - 70)));
  const ry = (d - 70) / 2;
  parts.push(P(line(60, ry, w - 60, ry), true));
  for (let x = 110; x < w - 80; x += 130) parts.push(P(line(x - 35, ry - 150, x + 35, ry + 150)));
  return parts;
}
function loft(w, d) {
  return [P(rect(0, 0, w, d), true), P(line(0, 0, w, d), true), P(line(w, 0, 0, d), true)];
}
function shoeRack(w, d) {
  const parts = [P(rect(0, 0, w, d)), P(line(0, d - 40, w, d - 40))];
  const n = Math.max(1, Math.round(w / 450));
  for (let i = 1; i < n; i++) parts.push(P(line((w * i) / n, 0, (w * i) / n, d)));
  for (let x = 90; x < w - 60; x += 150) parts.push(P(ellipse(x, d / 2 - 10, 45, 100)));
  return parts;
}
function bookshelf(w, d) {
  const parts = [P(rect(0, 0, w, d))];
  const n = Math.max(1, Math.round(w / 450));
  for (let i = 1; i < n; i++) parts.push(P(line((w * i) / n, 0, (w * i) / n, d)));
  for (let x = 30; x < w - 20; x += 45) {
    const hgt = d - 60 - ((x * 37) % 70);
    parts.push(P(line(x, 30, x, 30 + hgt)));
  }
  return parts;
}
function poojaUnit(w, d) {
  const parts = [P(rect(0, 0, w, d)), P(rect(90, 60, w - 180, d - 150)), P(line(0, d - 60, w, d - 60))];
  // small stepped platform
  parts.push(P(rect(w / 2 - 160, 100, 320, 90)), P(rect(w / 2 - 230, 190, 460, 80)));
  return parts;
}

function straightStair(w, d) {
  const tread = 250;
  const n = Math.max(3, Math.round(d / tread));
  const t = d / n;
  const parts = [P(rect(0, 0, w, d))];
  for (let i = 1; i < n; i++) parts.push(P(line(0, i * t, w, i * t)));
  // walking line, up from the bottom
  parts.push(P(line(w / 2, d - t / 2, w / 2, t * 0.6)));
  parts.push(P(poly([w / 2 - 70, t * 0.6 + 120, w / 2, t * 0.6, w / 2 + 70, t * 0.6 + 120])));
  parts.push(P(circle(w / 2, d - t / 2, 35)));
  // cut line
  const cy = d * 0.52;
  parts.push(P(poly([0, cy + 260, w * 0.44, cy + 50, w * 0.5, cy + 170, w * 0.56, cy - 60, w, cy - 260])));
  parts.push(T("UP", w / 2 + 170, d - t * 1.6, 150));
  return parts;
}
function dogLegStair(w, d) {
  const tread = 250, gap = 100;
  const fw = (w - gap) / 2;
  const landing = Math.min(fw, d * 0.4);
  const run = d - landing;
  const n = Math.max(3, Math.round(run / tread));
  const t = run / n;
  const parts = [P(rect(0, 0, w, d)), P(line(0, landing, w, landing)), P(rect(fw, landing, gap, run))];
  for (let i = 1; i < n; i++) {
    parts.push(P(line(0, landing + i * t, fw, landing + i * t)));
    parts.push(P(line(fw + gap, landing + i * t, w, landing + i * t)));
  }
  // walking line: up the right flight, across the landing, down the left flight
  const xr = fw + gap + fw / 2, xl = fw / 2;
  const ly = landing / 2, cr = Math.min(200, ly * 0.6);
  parts.push(P([["M", xr, d - t / 2], ["L", xr, ly + cr], ...arc(xr - cr, ly + cr, cr, 0, -Math.PI / 2, false), ["L", xl + cr, ly],
    ...arc(xl + cr, ly + cr, cr, -Math.PI / 2, -Math.PI, false), ["L", xl, d - t * 1.2]]));
  const cy = landing + run * 0.45;
  parts.push(P(poly([fw + gap, cy + 200, fw + gap + fw * 0.44, cy + 40, fw + gap + fw * 0.5, cy + 140, fw + gap + fw * 0.56, cy - 40, w, cy - 200])));
  parts.push(P(poly([xl - 70, d - t * 1.2 - 120, xl, d - t * 1.2, xl + 70, d - t * 1.2 - 120])));
  parts.push(P(circle(xr, d - t / 2, 35)));
  parts.push(T("UP", xr + 230, d - t * 1.5, 150));
  return parts;
}

function car(w, d, p = {}) {
  const parts = [];
  parts.push(P(rrect(0, 0, w, d, w * 0.28)));
  // bonnet line, windscreen, roof, rear window
  const r = (y) => y * d;
  parts.push(P([["M", w * 0.08, r(0.27)], ["C", w * 0.3, r(0.25), w * 0.7, r(0.25), w * 0.92, r(0.27)]]));
  parts.push(P(poly([w * 0.1, r(0.3), w * 0.9, r(0.3), w * 0.84, r(0.42), w * 0.16, r(0.42)], true)));
  parts.push(P(rrect(w * 0.15, r(0.43), w * 0.7, r(p.suv ? 0.33 : 0.27), 60)));
  const rw = p.suv ? 0.78 : 0.72;
  parts.push(P(poly([w * 0.16, r(rw - 0.01), w * 0.84, r(rw - 0.01), w * 0.88, r(rw + 0.07), w * 0.12, r(rw + 0.07)], true)));
  // mirrors
  parts.push(P(rrect(-110, r(0.3), 110, 70, 25)), P(rrect(w, r(0.3), 110, 70, 25)));
  return parts;
}
function twoWheeler(w, d) {
  const cx = w / 2;
  return [
    P(rrect(cx - 110, d * 0.06, 220, d * 0.88, 110)),
    P(line(0, d * 0.24, w, d * 0.24)), P(rrect(-10, d * 0.21, 120, 90, 40)), P(rrect(w - 110, d * 0.21, 120, 90, 40)),
    P(rrect(cx - 150, d * 0.42, 300, d * 0.32, 120)),
    P(ellipse(cx, d * 0.06, 70, 60)), P(ellipse(cx, d * 0.94, 70, 60))
  ];
}
function tree(w) {
  const r = w / 2;
  return [P(scallop(r, r, r, 14)), P(circle(r, r, r * 0.08)), P(line(r - r * 0.35, r, r + r * 0.35, r)), P(line(r, r - r * 0.35, r, r + r * 0.35))];
}
function shrub(w) {
  const r = w / 2;
  return [P(scallop(r, r, r, 9)), P(scallop(r, r, r * 0.5, 6))];
}
function planter(w, d) {
  return [P(rect(0, 0, w, d)), P(rect(50, 50, w - 100, d - 100)), P(scallop(w / 2, d / 2, Math.min(w, d) * 0.3, 7))];
}

/* ---------- catalogue ---------- */

// Each family: one drawing; each size is a tile in the library and a choice in its Size menu.
export const BLOCK_CATEGORIES = [
  { id: "doors", name: "Doors and windows" },
  { id: "bedroom", name: "Bedroom" },
  { id: "living", name: "Living" },
  { id: "dining", name: "Dining" },
  { id: "kitchen", name: "Kitchen and utility" },
  { id: "bath", name: "Bathroom" },
  { id: "storage", name: "Storage" },
  { id: "stairs", name: "Stairs" },
  { id: "outdoor", name: "Outdoor and parking" }
];

export const BLOCK_FAMILIES = [
  { id: "door", cat: "doors", draw: (w) => singleDoor(w), box: (w) => [w, w], sizes: [
    { name: "Single door", label: "900", w: 900, d: 900, tile: true }, { label: "750", w: 750, d: 750 }, { label: "1000", w: 1000, d: 1000 }, { label: "1050", w: 1050, d: 1050 }, { label: "1200", w: 1200, d: 1200 }] },
  { id: "door2", cat: "doors", draw: (w) => doubleDoor(w), box: (w) => [w, w / 2], sizes: [
    { name: "Double door", label: "1200", w: 1200, d: 600, tile: true }, { label: "1500", w: 1500, d: 750 }, { label: "1800", w: 1800, d: 900 }] },
  { id: "sliding-door", cat: "doors", draw: slidingDoor, sizes: [
    { name: "Sliding door", label: "1800", w: 1800, d: 230, tile: true }, { label: "1500", w: 1500, d: 230 }, { label: "2400", w: 2400, d: 230 }] },
  { id: "window", cat: "doors", draw: windowBlock, sizes: [
    { name: "Window", label: "1500", w: 1500, d: 230, tile: true }, { label: "900", w: 900, d: 230 }, { label: "1200", w: 1200, d: 230 }, { label: "1800", w: 1800, d: 230 }, { label: "2100", w: 2100, d: 230 }] },
  { id: "sliding-window", cat: "doors", draw: slidingWindow, sizes: [
    { name: "Sliding window", label: "1500", w: 1500, d: 230, tile: true }, { label: "1200", w: 1200, d: 230 }, { label: "1800", w: 1800, d: 230 }] },
  { id: "ventilator", cat: "doors", draw: ventilator, sizes: [
    { name: "Ventilator", label: "600", w: 600, d: 230, tile: true }, { label: "450", w: 450, d: 230 }, { label: "900", w: 900, d: 230 }] },

  { id: "bed", cat: "bedroom", draw: bed, sizes: [
    { name: "Single bed", w: 900, d: 1950, tile: true }, { name: "Double bed", w: 1350, d: 1950, tile: true },
    { name: "Queen bed", w: 1500, d: 2000, tile: true }, { name: "King bed", w: 1800, d: 2000, tile: true }] },
  { id: "bedside", cat: "bedroom", draw: bedsideTable, sizes: [{ name: "Bedside table", w: 450, d: 450, tile: true }, { label: "500", w: 500, d: 450 }] },
  { id: "study", cat: "bedroom", draw: studyTable, sizes: [{ name: "Study table", w: 1200, d: 950, tile: true }, { label: "1000", w: 1000, d: 950 }, { label: "1500", w: 1500, d: 950 }] },
  { id: "dresser", cat: "bedroom", draw: dressingTable, sizes: [{ name: "Dressing table", w: 900, d: 900, tile: true }, { label: "1200", w: 1200, d: 900 }] },

  { id: "sofa", cat: "living", draw: sofa, sizes: [
    { name: "1-seater sofa", w: 900, d: 850, p: { seats: 1 }, tile: true }, { name: "2-seater sofa", w: 1500, d: 850, p: { seats: 2 }, tile: true },
    { name: "3-seater sofa", w: 2100, d: 850, p: { seats: 3 }, tile: true }] },
  { id: "lsofa", cat: "living", draw: lSofa, sizes: [{ name: "L-shaped sofa", w: 2700, d: 1800, tile: true }, { label: "2400 × 1600", w: 2400, d: 1600 }, { label: "3000 × 2100", w: 3000, d: 2100 }] },
  { id: "coffee", cat: "living", draw: coffeeTable, sizes: [{ name: "Coffee table", w: 1200, d: 600, tile: true }, { label: "900 × 600", w: 900, d: 600 }, { label: "1400 × 700", w: 1400, d: 700 }] },
  { id: "sidetable", cat: "living", draw: sideTable, sizes: [{ name: "Side table", w: 450, d: 450, tile: true }, { label: "600", w: 600, d: 600 }] },
  { id: "tv", cat: "living", draw: tvUnit, sizes: [{ name: "TV unit", w: 1800, d: 450, tile: true }, { label: "1500", w: 1500, d: 450 }, { label: "2400", w: 2400, d: 450 }] },

  { id: "dining", cat: "dining", draw: dining, sizes: [
    { name: "4-seater dining", w: 1200, d: 1500, p: { side: 2 }, tile: true },
    { name: "6-seater dining", w: 1800, d: 1600, p: { side: 3 }, tile: true },
    { name: "8-seater dining", w: 3100, d: 1700, p: { side: 3, ends: true }, tile: true },
    { name: "10-seater dining", w: 3700, d: 1700, p: { side: 4, ends: true }, tile: true },
    { name: "12-seater dining", w: 4300, d: 1800, p: { side: 5, ends: true }, tile: true }] },
  { id: "round-dining", cat: "dining", draw: roundDining, sizes: [
    { name: "Round 4-seater", w: 1700, d: 1700, p: { seats: 4 }, tile: true }, { name: "Round 6-seater", w: 2000, d: 2000, p: { seats: 6 } }] },

  { id: "hob", cat: "kitchen", draw: hob, sizes: [
    { name: "Hob, 2 burner", w: 730, d: 410, p: { burners: 2 }, tile: true }, { name: "Hob, 3 burner", w: 780, d: 500, p: { burners: 3 }, tile: true },
    { name: "Hob, 4 burner", w: 600, d: 580, p: { burners: 4 }, tile: true }] },
  { id: "chimney", cat: "kitchen", draw: chimney, sizes: [{ name: "Chimney (above)", w: 900, d: 500, tile: true }, { label: "600", w: 600, d: 500 }] },
  { id: "sink", cat: "kitchen", draw: sink, sizes: [
    { name: "Sink", w: 800, d: 500, tile: true }, { name: "Sink, double bowl", w: 1150, d: 500, p: { bowls: 2 }, tile: true },
    { name: "Sink with drainboard", w: 1000, d: 500, p: { drain: true }, tile: true }] },
  { id: "fridge", cat: "kitchen", draw: fridge, sizes: [
    { name: "Fridge", w: 600, d: 650, tile: true }, { name: "Fridge, double door", w: 750, d: 700, p: { doors: 2 } },
    { name: "Fridge, side by side", w: 900, d: 750, p: { doors: 2 } }] },
  { id: "dishwasher", cat: "kitchen", draw: dishwasher, sizes: [{ name: "Dishwasher", w: 600, d: 600, tile: true }] },
  { id: "washer", cat: "kitchen", draw: washingMachine, sizes: [{ name: "Washing machine", w: 600, d: 600, tile: true }] },

  { id: "ewc", cat: "bath", draw: westernWC, sizes: [{ name: "Western WC", w: 450, d: 700, tile: true }] },
  { id: "wallwc", cat: "bath", draw: wallWC, sizes: [{ name: "Wall-hung WC", w: 360, d: 540, tile: true }] },
  { id: "iwc", cat: "bath", draw: indianWC, sizes: [{ name: "Indian WC", w: 450, d: 580, tile: true }] },
  { id: "basin", cat: "bath", draw: washbasin, sizes: [{ name: "Washbasin", w: 550, d: 450, tile: true }, { label: "450", w: 450, d: 400 }, { label: "600", w: 600, d: 480 }] },
  { id: "counterbasin", cat: "bath", draw: counterBasin, sizes: [{ name: "Counter basin", w: 900, d: 550, tile: true }, { label: "1200", w: 1200, d: 550 }] },
  { id: "shower", cat: "bath", draw: shower, sizes: [{ name: "Shower", w: 900, d: 900, tile: true }, { label: "1000 × 1000", w: 1000, d: 1000 }, { label: "1200 × 900", w: 1200, d: 900 }] },
  { id: "bathtub", cat: "bath", draw: bathtub, sizes: [{ name: "Bathtub", w: 1700, d: 750, tile: true }, { label: "1500 × 700", w: 1500, d: 700 }] },

  { id: "wardrobe", cat: "storage", draw: wardrobe, sizes: [
    { name: "Wardrobe, 2 door", w: 1200, d: 600, tile: true }, { name: "Wardrobe, 3 door", w: 1800, d: 600, tile: true },
    { name: "Wardrobe, 4 door", w: 2400, d: 600, tile: true }] },
  { id: "loft", cat: "storage", draw: loft, sizes: [{ name: "Loft (above)", w: 1800, d: 600, tile: true }] },
  { id: "shoerack", cat: "storage", draw: shoeRack, sizes: [{ name: "Shoe rack", w: 900, d: 350, tile: true }, { label: "1200", w: 1200, d: 350 }] },
  { id: "bookshelf", cat: "storage", draw: bookshelf, sizes: [{ name: "Bookshelf", w: 900, d: 350, tile: true }, { label: "1200", w: 1200, d: 350 }, { label: "1800", w: 1800, d: 350 }] },
  { id: "pooja", cat: "storage", draw: poojaUnit, sizes: [{ name: "Pooja unit", w: 900, d: 600, tile: true }, { label: "1200", w: 1200, d: 600 }] },

  { id: "stair", cat: "stairs", draw: straightStair, sizes: [{ name: "Straight stair", w: 1000, d: 3500, tile: true }, { label: "1200 wide", w: 1200, d: 3500 }] },
  { id: "dogleg", cat: "stairs", draw: dogLegStair, sizes: [{ name: "Dog-legged stair", w: 2100, d: 3500, tile: true }, { label: "2500 wide", w: 2500, d: 3750 }] },

  { id: "car", cat: "outdoor", draw: car, sizes: [{ name: "Car", w: 1800, d: 4500, tile: true }, { name: "SUV", w: 1900, d: 4800, p: { suv: true }, tile: true }] },
  { id: "bike", cat: "outdoor", draw: twoWheeler, sizes: [{ name: "Two-wheeler", w: 750, d: 1900, tile: true }] },
  { id: "tree", cat: "outdoor", draw: (w) => tree(w), sizes: [{ name: "Tree", w: 3000, d: 3000, tile: true }, { label: "Ø 2000", w: 2000, d: 2000 }, { label: "Ø 4500", w: 4500, d: 4500 }] },
  { id: "shrub", cat: "outdoor", draw: (w) => shrub(w), sizes: [{ name: "Shrub", w: 900, d: 900, tile: true }, { label: "Ø 600", w: 600, d: 600 }] },
  { id: "planter", cat: "outdoor", draw: planter, sizes: [{ name: "Planter", w: 600, d: 600, tile: true }, { label: "900 × 450", w: 900, d: 450 }] }
];

export function blockParts(familyId, w, d, p) {
  const f = BLOCK_FAMILIES.find((x) => x.id === familyId);
  return f ? f.draw(w, d, p || {}) : [];
}

/** Library tiles: one per named size marked as a tile. */
export function blockTiles() {
  const out = [];
  for (const f of BLOCK_FAMILIES) {
    for (const s of f.sizes) if (s.tile) out.push({ family: f.id, cat: f.cat, name: s.name, w: s.w, d: s.d, p: s.p || null });
  }
  return out;
}

export function sizeText(w, d) {
  return `${Math.round(w)} × ${Math.round(d)}`;
}
