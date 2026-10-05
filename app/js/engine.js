// Talks to the MuPDF worker. The engine is downloaded the first time a feature needs it.
let worker = null;
let ready = null;
let seq = 0;
const pending = new Map();

export class EngineError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function start() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    try {
      worker = new Worker(new URL("./mupdf-worker.js", import.meta.url), { type: "module" });
    } catch (e) {
      reject(new EngineError("This phone's browser can't run the PDF engine.", "unsupported"));
      return;
    }
    const fail = () => {
      ready = null;
      if (worker) worker.terminate();
      worker = null;
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      const err = new EngineError(offline
        ? "This needs the internet the first time, to download the PDF engine. Connect and try again."
        : "The PDF engine couldn't start. Try again.", offline ? "offline" : "load");
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      reject(err);
    };
    worker.onerror = fail;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.ready) { worker.onerror = (ev) => console.error("PDF engine error", ev); resolve(); return; }
      const p = pending.get(m.id);
      if (!p) return;
      if (m.progress) { p.onProgress && p.onProgress(m.progress); return; }
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new EngineError(m.error, m.error === "password" ? "password" : "failed"));
    };
  });
  return ready;
}

export function preloadEngine() {
  return start().catch(() => {});
}

export async function engine(op, args, { onProgress, transfer = [] } = {}) {
  await start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, op, args }, transfer);
  });
}
