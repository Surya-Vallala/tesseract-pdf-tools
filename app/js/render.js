// Drawing pages onto canvases, with a small priority queue so the page you're
// looking at is always drawn first.
import { FULL, imagePlacement, pdfjsLib } from "./doc.js";

const MAX_ACTIVE = 2;
const queue = [];
let active = 0;

export class CancelledError extends Error {
  constructor() { super("cancelled"); this.cancelled = true; }
}

class Job {
  constructor(pri, run) {
    this.pri = pri;
    this.run = run;
    this.cancelled = false;
    this.done = false;
    this.task = null;
    this.promise = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; });
    this.promise.catch(() => {});
  }
  cancel() {
    if (this.cancelled || this.done) return;
    this.cancelled = true;
    if (this.task) { try { this.task.cancel(); } catch (e) { /* ignore */ } }
    const i = queue.indexOf(this);
    if (i >= 0) { queue.splice(i, 1); this.done = true; this._reject(new CancelledError()); }
  }
}

export function schedule(pri, run) {
  const job = new Job(pri, run);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].pri > queue[best].pri) best = i;
    const job = queue.splice(best, 1)[0];
    active++;
    Promise.resolve()
      .then(() => (job.cancelled ? Promise.reject(new CancelledError()) : job.run(job)))
      .then(
        (v) => { job.done = true; job._resolve(v); },
        (e) => { job.done = true; job._reject(job.cancelled || (e && e.name === "RenderingCancelledException") ? new CancelledError() : e); }
      )
      .finally(() => { active--; pump(); });
  }
}

export function cropUserRect(view, crop) {
  const [vx0, vy0, vx1, vy1] = view;
  const W = vx1 - vx0;
  const H = vy1 - vy0;
  return [vx0 + crop.x0 * W, vy1 - crop.y1 * H, vx0 + crop.x1 * W, vy1 - crop.y0 * H];
}

/**
 * Draw part of a page.
 * scale: canvas pixels per point of the finished page (or per content unit with contentOnly).
 * region: {x, y, w, h} in canvas pixels of the whole page at that scale.
 */
export async function drawPage(doc, p, scale, region, canvas, job, { contentOnly = false } = {}) {
  const s = doc.src(p);
  const cw = Math.max(1, Math.round(region.w));
  const ch = Math.max(1, Math.round(region.h));
  if (s.kind === "pdf") {
    const page = await s.pdf.getPage(p.index + 1);
    if (job && job.cancelled) throw new CancelledError();
    const info = s.pages[p.index];
    const R = (((info.rotate + p.rot) % 360) + 360) % 360;
    const vp = page.getViewport({ scale, rotation: R });
    let ox = 0;
    let oy = 0;
    if (p.crop) {
      const r = cropUserRect(info.view, p.crop);
      const a = vp.convertToViewportPoint(r[0], r[1]);
      const b = vp.convertToViewportPoint(r[2], r[3]);
      ox = Math.min(a[0], b[0]);
      oy = Math.min(a[1], b[1]);
    }
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { alpha: false });
    const task = page.render({
      canvasContext: ctx,
      canvas,
      viewport: vp,
      transform: [1, 0, 0, 1, -(ox + region.x), -(oy + region.y)],
      optionalContentConfigPromise: s.oc ? Promise.resolve(s.oc) : null,
      annotationMode: doc.commentsVisible ? pdfjsLib.AnnotationMode.ENABLE : pdfjsLib.AnnotationMode.DISABLE,
      background: "#ffffff"
    });
    if (job) job.task = task;
    await task.promise;
    return;
  }

  // Photo or blank page
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  if (s.kind === "blank") return;
  const { R } = doc.base(p);
  const c = p.crop || FULL;
  const cs = doc.contentSize(p);
  const place = contentOnly ? { x: 0, y: 0, w: cs.w, h: cs.h } : imagePlacement(doc.pageSize(p), cs.w, cs.h);
  const turned = R % 180 === 90;
  const dw = turned ? place.h : place.w;
  const dh = turned ? place.w : place.h;
  const bw = s.bitmap.width;
  const bh = s.bitmap.height;
  ctx.save();
  ctx.translate(-region.x, -region.y);
  ctx.scale(scale, scale);
  ctx.translate(place.x + place.w / 2, place.y + place.h / 2);
  ctx.rotate((R * Math.PI) / 180);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(s.bitmap, c.x0 * bw, c.y0 * bh, (c.x1 - c.x0) * bw, (c.y1 - c.y0) * bh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

export function renderKey(doc, p) {
  const s = doc.src(p);
  const c = p.crop ? `${p.crop.x0.toFixed(4)},${p.crop.y0.toFixed(4)},${p.crop.x1.toFixed(4)},${p.crop.y1.toFixed(4)}` : "-";
  const extra = s.kind === "image" ? doc.imageFit : s.kind === "pdf" ? (s.oc ? s.oc.getHash() : "") + (doc.commentsVisible ? "c" : "n") : "";
  return `${p.src}:${p.index}:${p.rot}:${c}:${extra}`;
}
