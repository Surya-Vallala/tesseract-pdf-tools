/* Tesseract PDF Tools - service worker
   Keeps the app working offline and receives files shared from other apps.
   Bump VERSION with every release so phones pick up the new files. */
const VERSION = "1.6.1";
const APP_CACHE = "tpt-app-" + VERSION;
const RUNTIME_CACHE = "tpt-runtime";
const INBOX_CACHE = "tpt-share-inbox";

const CORE = [
  "./",
  "index.html",
  "app.css",
  "manifest.webmanifest",
  "js/main.js",
  "js/ui.js",
  "js/doc.js",
  "js/render.js",
  "js/viewer.js",
  "js/pages.js",
  "js/crop.js",
  "js/layers.js",
  "js/save.js",
  "js/geom.js",
  "js/shapes.js",
  "js/overlay.js",
  "js/watermark.js",
  "js/markup.js",
  "js/comments.js",
  "js/tools.js",
  "js/ocr.js",
  "js/engine.js",
  "js/platform.js",
  "js/contentfilter.js",
  "js/blocks.js",
  "js/blockui.js",
  "js/snap.js",
  "js/dgeom.js",
  "js/interop.js",
  "js/mupdf-worker.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/maskable-192.png",
  "icons/maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-48.png",
  "icons/tesseract-logo-black.png",
  "icons/tesseract-logo-white.png",
  "vendor/pdf-lib.min.js",
  "vendor/pdfjs/pdf.min.mjs",
  "vendor/pdfjs/pdf.worker.min.mjs",
  "vendor/pdfjs/wasm/jbig2.wasm",
  "vendor/pdfjs/wasm/openjpeg.wasm",
  "vendor/pdfjs/wasm/qcms_bg.wasm",
  "vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc",
  "vendor/pdfjs/standard_fonts/FoxitDingbats.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixed.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerif.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSymbol.pfb",
  "vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf",
  "vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf",
  "vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf",
  "vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(CORE.map((u) => new Request(u, { cache: "reload" }))))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("tpt-app-") && k !== APP_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);

  if (req.method === "POST" && url.pathname === new URL("share-target", scope).pathname) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== "GET" || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cached = await caches.match("index.html", { cacheName: APP_CACHE });
      if (cached) return cached;
      return fetch(req);
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    const res = await fetch(req);
    // Character maps and fallbacks are only needed for some files; keep them once fetched.
    if (res.ok && url.pathname.includes("/vendor/")) {
      const copy = res.clone();
      caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
    }
    return res;
  })());
});

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll("files").filter((f) => f && typeof f === "object" && "size" in f);
    const inbox = await caches.open(INBOX_CACHE);
    for (const key of await inbox.keys()) await inbox.delete(key);
    const stamp = Date.now();
    let i = 0;
    for (const f of files) {
      const name = f.name || "shared-file";
      const key = new URL("share-inbox/" + stamp + "-" + String(i++).padStart(3, "0"), self.registration.scope).href;
      await inbox.put(key, new Response(f, {
        headers: {
          "Content-Type": f.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(name)
        }
      }));
    }
  } catch (e) {
    // Fall through: the app opens and shows its home screen.
  }
  return Response.redirect(new URL("./?share=1", self.registration.scope).href, 303);
}
