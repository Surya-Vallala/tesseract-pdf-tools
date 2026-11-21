// A recovery copy of every file with unsaved changes, kept on this phone and brought up to date
// a moment after each change, so work isn't lost if the app is closed unexpectedly (or Android
// closes it in the background). The copy is deleted when the file is saved or its changes are
// discarded. Password-protected PDFs are kept as they came (still locked), never unlocked.
import { picsOf } from "./pics.js";

const DB_NAME = "tpt-recovery";
const WAIT = 1200; // ms after the last change

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("docs", { keyPath: "id" });
        d.createObjectStore("data"); // file bytes and pictures, key "<doc id>/..."
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

const done = (t) => new Promise((resolve, reject) => {
  t.oncomplete = () => resolve();
  t.onerror = () => reject(t.error);
  t.onabort = () => reject(t.error);
});
const result = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const range = (id) => IDBKeyRange.bound(id + "/", id + "/￿");

// This window of the app. Another window that is still open answers for its own copies, so they
// aren't offered as left over.
const session = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
let channel = null;
try {
  channel = new BroadcastChannel("tpt-recovery");
  channel.onmessage = (e) => { if (e.data && e.data.ask) channel.postMessage({ alive: session }); };
} catch (e) { /* one window only */ }

const ids = new WeakMap();     // doc -> its copy's id
const written = new WeakMap(); // doc -> Map(key -> the bytes / blob already written under it)
const timers = new Map();      // doc -> pending write
const busy = new Map();        // doc -> write in progress

/** Keeps a recovery copy of this document while it has unsaved changes. id: an earlier copy to carry on. */
export function watch(doc, id = null) {
  if (ids.has(doc)) return;
  ids.set(doc, id || "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  doc.on("dirty", (on) => (on ? changed(doc) : drop(doc)));
  doc.on("pages", () => changed(doc));
  if (doc.dirty) changed(doc);
}

/** Something in the document changed: bring its copy up to date shortly. */
export function changed(doc) {
  if (!ids.has(doc) || !doc.dirty) return;
  clearTimeout(timers.get(doc));
  timers.set(doc, setTimeout(() => { timers.delete(doc); write(doc); }, WAIT));
}

/** The document was saved, its changes discarded, or it was closed: its copy goes. */
export function forget(doc) {
  if (ids.has(doc)) drop(doc);
}

/** Writes every pending copy now (the app is going to the background). */
export function flush() {
  for (const [doc, t] of [...timers]) {
    clearTimeout(t);
    timers.delete(doc);
    write(doc);
  }
}

function drop(doc) {
  clearTimeout(timers.get(doc));
  timers.delete(doc);
  written.delete(doc);
  const id = ids.get(doc);
  const after = busy.get(doc) || Promise.resolve();
  after.then(() => remove(id)).catch(() => {});
}

async function remove(id) {
  try {
    const d = await db();
    const t = d.transaction(["docs", "data"], "readwrite");
    t.objectStore("docs").delete(id);
    t.objectStore("data").delete(range(id));
    await done(t);
  } catch (e) { /* nothing kept */ }
}

function write(doc) {
  const prev = busy.get(doc) || Promise.resolve();
  const p = prev.then(() => writeNow(doc)).catch((e) => console.warn("Recovery copy not written", e));
  busy.set(doc, p);
  p.then(() => { if (busy.get(doc) === p) busy.delete(doc); });
  return p;
}

async function writeNow(doc) {
  const id = ids.get(doc);
  if (!id || !doc.dirty || !doc.pages.length) return;
  const state = doc.snapshot();
  delete state.password; // the password a saved copy gets is not kept
  const used = new Set(doc.pages.map((p) => p.src));
  const keep = new Set();
  const puts = [];
  const old = written.get(doc) || new Map();
  const want = (key, data) => { keep.add(key); if (old.get(key) !== data) puts.push([key, data]); };
  const sources = [];
  for (const s of doc.sources.values()) {
    if (!used.has(s.id)) continue;
    const m = { id: s.id, kind: s.kind, name: s.name, w: s.w, h: s.h };
    if (s.kind === "pdf") {
      m.key = `${id}/s${s.id}`;
      m.locked = !!s.lockedBytes; // kept locked: the password is asked for when it is restored
      want(m.key, s.lockedBytes || s.bytes);
      if (s.oc) {
        try { m.oc = [...s.oc].map(([gid, g]) => [gid, !!g.visible]); } catch (e) { /* no layers */ }
      }
    } else if (s.kind === "image") {
      m.key = `${id}/s${s.id}`;
      want(m.key, s.blob);
    }
    if (s.ocr) m.ocr = s.ocr; // recognised text
    sources.push(m);
  }
  const pics = [];
  for (const [hash, p] of picsOf(doc)) {
    if (!p || !p.blob) continue;
    const key = `${id}/p${hash}`;
    want(key, p.blob);
    pics.push({ hash, key, type: p.type, pw: p.pw, ph: p.ph });
  }
  const pdfs = [...doc.sources.values()].filter((s) => s.kind === "pdf" && used.has(s.id));
  const pw = doc.password ? (pdfs.length === 1 && pdfs[0].password === doc.password ? "source" : "other") : null;
  const rec = { id, session, at: Date.now(), name: doc.name, state, sources, pics, commentsVisible: doc.commentsVisible, pw };
  const d = await db();
  const stale = await result(d.transaction("data").objectStore("data").getAllKeys(range(id)));
  if (!doc.dirty || ids.get(doc) !== id) return; // saved meanwhile
  const t = d.transaction(["docs", "data"], "readwrite");
  const data = t.objectStore("data");
  for (const k of stale) if (!keep.has(k)) data.delete(k);
  for (const [k, v] of puts) data.put(v, k);
  t.objectStore("docs").put(rec);
  await done(t);
  const now = new Map();
  for (const k of keep) now.set(k, puts.find(([pk]) => pk === k)?.[1] ?? old.get(k));
  written.set(doc, now);
  if (!doc.dirty) remove(id); // saved while this was being written
}

/** Copies left from an earlier time the app ran (not from a window that is still open), newest first. */
export async function leftovers() {
  let all;
  try {
    const d = await db();
    all = await result(d.transaction("docs").objectStore("docs").getAll());
  } catch (e) {
    return [];
  }
  all = all.filter((r) => r.session !== session);
  if (!all.length) return [];
  const alive = new Set();
  if (channel) {
    const listen = (e) => { if (e.data && e.data.alive) alive.add(e.data.alive); };
    channel.addEventListener("message", listen);
    channel.postMessage({ ask: true });
    await new Promise((r) => setTimeout(r, 350));
    channel.removeEventListener("message", listen);
  }
  return all.filter((r) => !alive.has(r.session)).sort((a, b) => b.at - a.at);
}

/** A copy's files: [{ meta, file }] in the document's order (file is null for blank pages). */
export async function filesOf(rec) {
  const d = await db();
  const store = d.transaction("data").objectStore("data");
  const out = [];
  for (const m of rec.sources) {
    let file = null;
    if (m.key) {
      const data = await result(store.get(m.key));
      if (data == null) throw new Error("missing");
      const type = m.kind === "pdf" ? "application/pdf" : (data.type || "");
      const name = m.kind === "pdf" && !/\.pdf$/i.test(m.name || "") ? (m.name || "File") + ".pdf" : (m.name || "Photo");
      file = new File([data], name, { type });
    }
    out.push({ meta: m, file });
  }
  return out;
}

/** A copy's pictures: [[hash, { blob, type, pw, ph, url }]]. */
export async function picturesOf(rec) {
  const d = await db();
  const store = d.transaction("data").objectStore("data");
  const out = [];
  for (const p of rec.pics || []) {
    const blob = await result(store.get(p.key));
    if (blob) out.push([p.hash, { blob, type: p.type, pw: p.pw, ph: p.ph, url: null }]);
  }
  return out;
}

/** Deletes a left-over copy. */
export function discard(rec) {
  return remove(rec.id);
}
