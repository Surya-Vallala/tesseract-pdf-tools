// Watermark layout, shared by the on-screen preview and the saved PDF.
// Positions are in shown-page coordinates (points, y going down).

export const WM_TEXT_SIZE = { small: 0.035, medium: 0.055, large: 0.08 };
export const WM_IMAGE_SIZE = { small: 0.22, medium: 0.4, large: 0.62 };

export function wmAppliesTo(spec, key) {
  return !!spec && (!spec.keys || spec.keys.includes(key));
}

let measureCtx = null;
export function measureBold(text, size) {
  if (!measureCtx) measureCtx = new OffscreenCanvas(8, 8).getContext("2d");
  measureCtx.font = `700 ${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}

/** measure(text, size) -> width */
export function wmLayout(spec, dw, dh, measure = measureBold) {
  const diag = Math.hypot(dw, dh);
  const angle = spec.dir === "diag" ? -Math.atan2(dh, dw) : 0;
  let w, h, fs = 0;
  if (spec.type === "image" && spec.image) {
    w = Math.min(dw, dh) * (WM_IMAGE_SIZE[spec.size] || 0.4) * (spec.repeat === "tile" ? 0.45 : 1);
    h = w * (spec.image.h / spec.image.w);
  } else {
    fs = diag * (WM_TEXT_SIZE[spec.size] || 0.055) * (spec.repeat === "tile" ? 0.6 : 1);
    w = measure(spec.text || " ", fs);
    const room = (spec.dir === "diag" ? diag : dw) * 0.9;
    if (w > room) { fs *= room / w; w = room; }
    h = fs;
  }
  const cx = dw / 2, cy = dh / 2;
  const centers = [];
  if (spec.repeat !== "tile") {
    centers.push([cx, cy]);
  } else {
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const vx = -uy, vy = ux;
    const img = spec.type === "image" && spec.image;
    const sx = img ? w * 1.7 : w * 1.5 + h, sy = img ? h * 1.7 : h * 3.2;
    const n = Math.ceil(diag / Math.min(sx, sy)) + 1;
    for (let j = -n; j <= n; j++) {
      const off = (j % 2) * sx * 0.5;
      for (let i = -n; i <= n; i++) {
        const u = i * sx + off, v = j * sy;
        const x = cx + u * ux + v * vx, y = cy + u * uy + v * vy;
        if (x > -w / 2 && x < dw + w / 2 && y > -h && y < dh + h) centers.push([x, y]);
      }
    }
  }
  return { angle, w, h, fs, centers };
}

export function wmSVG(spec, dw, dh) {
  const L = wmLayout(spec, dw, dh);
  const deg = (L.angle * 180) / Math.PI;
  const op = spec.opacity ?? 0.35;
  let out = `<g opacity="${op}" pointer-events="none">`;
  for (const [x, y] of L.centers) {
    if (spec.type === "image" && spec.image) {
      out += `<image href="${spec.image.url}" x="${x - L.w / 2}" y="${y - L.h / 2}" width="${L.w}" height="${L.h}" preserveAspectRatio="none" transform="rotate(${deg} ${x} ${y})"/>`;
    } else {
      const t = String(spec.text || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      out += `<text x="${x}" y="${y}" font-size="${L.fs}" font-weight="700" font-family="Helvetica, Arial, sans-serif" fill="${spec.color}" text-anchor="middle" dominant-baseline="central" transform="rotate(${deg} ${x} ${y})">${t}</text>`;
    }
  }
  return out + "</g>";
}
