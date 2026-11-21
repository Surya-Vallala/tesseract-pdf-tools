// HEIC / HEIF photos: decoded in heif-worker.js, which downloads its reader (about 2 MB) the first
// time a HEIC photo is picked; after that it works offline.
let worker = null;
let seq = 0;
const pending = new Map();

function start() {
  if (worker) return worker;
  worker = new Worker(new URL("./heif-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve({ width: m.width, height: m.height, data: m.data });
    else p.reject(new Error(m.error));
  };
  worker.onerror = (ev) => {
    ev.preventDefault();
    const offline = navigator.onLine === false;
    for (const p of pending.values()) p.reject(new Error(offline ? "offline" : "load"));
    pending.clear();
    worker.terminate();
    worker = null;
  };
  return worker;
}

/** RGBA pixels of a HEIC photo: { width, height, data: Uint8ClampedArray }. */
export function decodeHeif(bytes) {
  const w = start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const copy = bytes.slice();
    w.postMessage({ id, bytes: copy }, [copy.buffer]);
  });
}
