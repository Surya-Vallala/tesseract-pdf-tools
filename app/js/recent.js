// Recent files: a private copy of the files you open and save, kept on this phone so they open
// again with one tap (Chrome and the Android app can't reopen a file from where it was).
// Up to MAX_FILES files and MAX_BYTES in all; the oldest go first.
import { drawPage } from "./render.js";
import { paintMarks } from "./pages.js";

const DB_NAME = "tpt-recent";
const MAX_FILES = 12;
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_ONE = 120 * 1024 * 1024; // bigger files aren't kept

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("meta", { keyPath: "id" });
        d.createObjectStore("files");
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

function changed() {
  window.dispatchEvent(new Event("tpt-recent"));
}

/** Newest first: [{ id, name, size, type, at, how: "opened" | "saved", thumb: Blob|null }] */
export async function listRecent() {
  try {
    const d = await db();
    const all = await result(d.transaction("meta").objectStore("meta").getAll());
    return all.sort((a, b) => b.at - a.at);
  } catch (e) {
    return [];
  }
}

let persistAsked = false;

/** Keeps a copy of a file you opened or saved. doc (optional) is used for the first-page preview. */
export async function rememberFile(file, { doc = null, how = "opened" } = {}) {
  if (!file || !file.size || file.size > MAX_ONE) return;
  try {
    if (!persistAsked && navigator.storage && navigator.storage.persist) {
      persistAsked = true;
      navigator.storage.persist().catch(() => {});
    }
    const list = await listRecent();
    const same = list.find((m) => m.name === file.name && m.size === file.size);
    const id = same ? same.id : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const meta = { id, name: file.name, size: file.size, type: file.type || "", at: Date.now(), how, thumb: same ? same.thumb : null };
    const d = await db();
    let t = d.transaction(["meta", "files"], "readwrite");
    t.objectStore("meta").put(meta);
    if (!same) t.objectStore("files").put(file.slice(0, file.size, file.type), id);
    await done(t);

    // The oldest go once there are too many, or they take too much room.
    const keep = [meta, ...list.filter((m) => m.id !== id)];
    let total = 0;
    const drop = [];
    keep.forEach((m, i) => {
      total += m.size;
      if (i >= MAX_FILES || (i > 0 && total > MAX_BYTES)) drop.push(m.id);
    });
    if (drop.length) {
      t = d.transaction(["meta", "files"], "readwrite");
      for (const x of drop) { t.objectStore("meta").delete(x); t.objectStore("files").delete(x); }
      await done(t);
    }
    changed();
    if (doc && (!same || how === "saved" || !same.thumb)) {
      setTimeout(() => addThumb(id, doc), 1200);
    }
  } catch (e) {
    console.warn("Recent files: couldn't keep a copy", e);
  }
}

async function addThumb(id, doc) {
  try {
    const p = doc.pages[0];
    if (!p) return;
    const sz = doc.pageSize(p);
    const k = 200 / Math.max(sz.w, sz.h);
    const canvas = document.createElement("canvas");
    await drawPage(doc, p, k, { x: 0, y: 0, w: sz.w * k, h: sz.h * k }, canvas, null);
    await paintMarks(doc, p, canvas);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.75));
    canvas.width = 0;
    if (!blob) return;
    const d = await db();
    const store = d.transaction("meta", "readwrite").objectStore("meta");
    const meta = await result(store.get(id));
    if (!meta) return;
    meta.thumb = blob;
    const t = d.transaction("meta", "readwrite");
    t.objectStore("meta").put(meta);
    await done(t);
    changed();
  } catch (e) {
    // The file may have been closed already: no preview, that's all.
  }
}

/** The kept copy, as a File, or null if it's gone. */
export async function recentFile(id) {
  try {
    const d = await db();
    const t = d.transaction(["meta", "files"]);
    const [meta, blob] = await Promise.all([result(t.objectStore("meta").get(id)), result(t.objectStore("files").get(id))]);
    if (!meta || !blob) return null;
    return new File([blob], meta.name, { type: meta.type || blob.type });
  } catch (e) {
    return null;
  }
}

export async function forgetRecent(id) {
  try {
    const d = await db();
    const t = d.transaction(["meta", "files"], "readwrite");
    t.objectStore("meta").delete(id);
    t.objectStore("files").delete(id);
    await done(t);
  } catch (e) { /* nothing kept */ }
  changed();
}

export async function clearRecent() {
  try {
    const d = await db();
    const t = d.transaction(["meta", "files"], "readwrite");
    t.objectStore("meta").clear();
    t.objectStore("files").clear();
    await done(t);
  } catch (e) { /* nothing kept */ }
  changed();
}

/** "just now", "5 min ago", "3 hours ago", "yesterday", "12 Oct" */
export function when(at) {
  const s = (Date.now() - at) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(at), now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) { const hrs = Math.floor(s / 3600); return `${hrs} hour${hrs === 1 ? "" : "s"} ago`; }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
