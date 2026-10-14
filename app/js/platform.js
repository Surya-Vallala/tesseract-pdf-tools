// Everything that moves files in and out of the app lives here. Inside the Android app (APK)
// these hand over to native.js; in Chrome they use the browser's own features.

import * as native from "./native.js";

export const isAndroidApp = native.isNative;

export function pickFiles({ multiple = false, accept = "application/pdf,.pdf,image/*", capture = null } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute("capture", capture);
    input.style.display = "none";
    let done = false;
    const finish = (files) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish([...input.files]));
    input.addEventListener("cancel", () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

export function canShareFiles(files) {
  if (native.isNative) return true;
  try {
    const probe = files || [new File([new Uint8Array(1)], "x.pdf", { type: "application/pdf" })];
    return !!(navigator.canShare && navigator.canShare({ files: probe }));
  } catch (e) {
    return false;
  }
}

/** Opens the phone's share menu. Returns "shared", "cancelled" or "needs-tap". */
export async function shareFiles(files, title) {
  if (native.isNative) return native.shareFiles(files, title);
  try {
    await navigator.share({ files, title: title || files[0].name });
    return "shared";
  } catch (err) {
    if (err && err.name === "AbortError") return "cancelled";
    if (err && err.name === "NotAllowedError") return "needs-tap";
    throw err;
  }
}

/** Saves to Downloads. Returns the name it was saved under. */
export async function downloadFile(file) {
  if (native.isNative) return native.saveFile(file);
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return file.name;
}

export async function downloadFiles(files) {
  if (native.isNative) {
    for (const f of files) await native.saveFile(f);
    return;
  }
  for (const f of files) {
    downloadFile(f);
    await new Promise((r) => setTimeout(r, 450));
  }
}

/** Files arriving from other apps: the Share menu (via the service worker, or the APK) and "Open with". */
export function onIncomingFiles(handler) {
  if (native.isNative) {
    native.onIncoming(handler);
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.has("share")) {
    history.replaceState({ depth: 0 }, "", location.pathname);
    (async () => {
      try {
        const inbox = await caches.open("tpt-share-inbox");
        const keys = (await inbox.keys()).sort((a, b) => a.url.localeCompare(b.url));
        const files = [];
        for (const k of keys) {
          const res = await inbox.match(k);
          const blob = await res.blob();
          const name = decodeURIComponent(res.headers.get("X-File-Name") || "Shared file");
          files.push(new File([blob], name, { type: blob.type }));
          await inbox.delete(k);
        }
        handler(files, { shared: true });
      } catch (e) {
        console.error(e);
        handler([], { shared: true, error: true });
      }
    })();
  }
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (lp) => {
      if (!lp.files || !lp.files.length) return;
      const files = await Promise.all(lp.files.map((fh) => fh.getFile()));
      handler(files, { launched: true });
    });
  }
}

export const settings = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem("tpt-" + key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem("tpt-" + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
};
