// The Android app (APK) runs this same web app inside Android's WebView. The WebView can't
// download files, open the share menu, or receive files from other apps by itself, so in the
// APK platform.js hands those jobs to the app's native side through these functions.
// In Chrome none of this runs: isNative is false.

const cap = window.Capacitor;
export const isNative = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());

const call = (plugin, method, options) => cap.nativePromise(plugin, method, options || {});

const fileId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const CHUNK = 3 * 1024 * 1024;

/** Copies a File into the app's private cache, in pieces so big PDFs don't run out of memory. */
async function writeOut(file) {
  const id = fileId();
  const mime = file.type || "application/octet-stream";
  let out = null;
  let offset = 0;
  do {
    const data = file.size ? await base64Of(file.slice(offset, offset + CHUNK)) : "";
    out = await call("Tesseract", "writeChunk", { id, name: file.name, mime, data, append: offset > 0 });
    offset += CHUNK;
  } while (offset < file.size);
  return out;
}

const isCancel = (err) => !!err && (err.code === "CANCELLED" || /cancel/i.test(String(err.message || err)));

/** Saves into the phone's Downloads folder. Returns the name it was saved under (Android adds " (1)" for duplicates). */
export async function saveFile(file) {
  const out = await writeOut(file);
  try {
    const r = await call("Tesseract", "saveToDownloads", { path: out.path, name: out.name, mime: file.type || "application/octet-stream" });
    return r.name || out.name;
  } catch (err) {
    if (isCancel(err)) {
      const e = new Error("cancelled");
      e.code = "CANCELLED";
      throw e;
    }
    throw err;
  }
}

/** Opens Android's share menu. Returns "shared" or "cancelled", like platform.shareFiles. */
export async function shareFiles(files, title) {
  const urls = [];
  for (const f of files) {
    const out = await writeOut(f);
    urls.push("file://" + out.path.split("/").map(encodeURIComponent).join("/"));
  }
  try {
    await call("Share", "share", { files: urls, title: title || files[0].name, dialogTitle: "Share" });
    return "shared";
  } catch (err) {
    if (isCancel(err)) return "cancelled";
    throw err;
  }
}

/** Files from "Open with" and the Share menu. The app keeps them until this listener is attached. */
export function onIncoming(handler) {
  cap.addListener("Tesseract", "incoming", async (ev) => {
    if (!ev) return;
    const list = ev.files || [];
    if (!list.length) {
      handler([], { shared: true, error: !!ev.error });
      return;
    }
    try {
      const files = [];
      for (const f of list) {
        const res = await fetch(cap.convertFileSrc(f.path));
        if (!res.ok) throw new Error(`Couldn't read ${f.name}`);
        const blob = await res.blob();
        files.push(new File([blob], f.name, { type: f.type || blob.type }));
      }
      handler(files, { shared: true, partial: !!ev.partial });
    } catch (e) {
      console.error(e);
      handler([], { shared: true, error: true });
    }
  });
}

/* ---------- updates: only when the person taps Check for updates ---------- */

const UPDATE_INFO = "https://surya-vallala.github.io/tesseract-pdf-tools/android/version.json";

export function newerThan(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** Reads android/version.json from the app's GitHub site. */
export async function fetchUpdateInfo() {
  const r = await call("Tesseract", "fetchText", { url: `${UPDATE_INFO}?t=${Date.now()}` });
  const info = JSON.parse(r.text);
  if (!info || !info.version || !info.url || !info.sha256) throw new Error("Bad update info");
  return info;
}

/** Downloads the new APK, checks it, and opens Android's installer. */
export async function installUpdate(info, onProgress) {
  const listener = cap.addListener("Tesseract", "updateProgress", (p) => { if (p && onProgress) onProgress(p); });
  try {
    await call("Tesseract", "installUpdate", { url: info.url, sha256: info.sha256 });
  } finally {
    listener.remove();
  }
}

/* ---------- scanning with Google's document scanner ---------- */

/** Opens Google's scanner. Resolves the pages as JPEG files, or [] if you cancel. Throws if it isn't available. */
export async function scanWithGoogle() {
  let r;
  try {
    r = await call("Tesseract", "scanDocument", { pageLimit: 60 });
  } catch (err) {
    if (isCancel(err)) return [];
    throw err;
  }
  const files = [];
  for (const f of r.files || []) {
    const res = await fetch(cap.convertFileSrc(f.path));
    if (!res.ok) throw new Error(`Couldn't read ${f.name}`);
    files.push(new File([await res.blob()], f.name, { type: f.type || "image/jpeg" }));
  }
  return files;
}
