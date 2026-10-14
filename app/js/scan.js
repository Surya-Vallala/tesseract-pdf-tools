// Scan pages: paper to PDF pages with the camera.
// In the Android app this opens Google's document scanner. In Chrome (or if Google's scanner isn't
// available) the built-in scanner takes a photo, guesses where the page is, lets you drag the four
// corners, then straightens and cleans the page.
import { h, icon, toast, busy, nextFrame, pushLayer, closeLayer, confirmDialog, segmented } from "./ui.js";
import { pickFiles, isAndroidApp, settings } from "./platform.js";
import { scanWithGoogle } from "./native.js";
import { findPage, outputSize, straighten, cleanUp } from "./scanimg.js";

const MAX_SOURCE = 3000; // longest side of the photo kept for straightening, in pixels

/** Resolves the scanned pages as JPEG files, in order, or [] if you cancel. */
export async function scanPages() {
  if (isAndroidApp) {
    try {
      return await scanWithGoogle();
    } catch (e) {
      console.warn("Google's scanner didn't open; using the built-in one", e);
    }
  }
  return builtInScanner();
}

function builtInScanner() {
  return new Promise((resolve) => {
    const pages = [];
    let filter = settings.get("scan-filter", "clean");
    let photo = null; // { rgba, w, h, bitmap, corners }
    let result = [];

    const scr = h(`<div class="crop-screen scanner" role="dialog" aria-label="Scan pages">
      <header class="crop-top">
        <button class="ib" type="button" data-close aria-label="Close">${icon("close")}</button>
        <h2 data-title>Scan pages</h2>
      </header>
      <div class="crop-stage scan-stage">
        <div class="scan-start" data-start>
          <span class="scan-big">${icon("scan")}</span>
          <p><b>Take a photo of the page.</b><br>Lay it flat on a darker surface so its edges stand out.</p>
          <button class="btn primary" type="button" data-take>${icon("camera")}<span>Take photo</span></button>
          <button class="btn" type="button" data-pick>${icon("image")}<span>Choose a photo</span></button>
          <div class="scan-ready" data-ready hidden>
            <span data-count></span>
            <button class="btn primary" type="button" data-finish-start>Done</button>
          </div>
        </div>
        <div class="scan-edit" data-edit hidden>
          <canvas data-canvas></canvas>
          <svg data-svg xmlns="http://www.w3.org/2000/svg">
            <polygon data-poly></polygon>
            <circle r="13" data-h="0"></circle><circle r="13" data-h="1"></circle><circle r="13" data-h="2"></circle><circle r="13" data-h="3"></circle>
          </svg>
          <canvas class="scan-loupe" data-loupe width="240" height="240" hidden></canvas>
        </div>
      </div>
      <footer class="crop-foot" data-foot hidden>
        <p class="scan-hint">Drag the corners to the edges of the page.</p>
        <div data-seg></div>
        <div class="row">
          <button class="btn" type="button" data-retake>Retake</button>
          <button class="btn" type="button" data-next>Next page</button>
          <button class="btn primary" type="button" data-finish>Done</button>
        </div>
      </footer>
    </div>`);
    const $ = (sel) => scr.querySelector(sel);
    const stage = $(".scan-stage");
    const canvas = $("[data-canvas]");
    const svg = $("[data-svg]");
    const poly = $("[data-poly]");
    const handles = [...scr.querySelectorAll("[data-h]")];
    const loupe = $("[data-loupe]");

    $("[data-seg]").appendChild(segmented(
      [{ value: "clean", label: "Clean" }, { value: "bw", label: "Black & white" }, { value: "original", label: "Original" }],
      filter,
      (v) => { filter = v; settings.set("scan-filter", v); }
    ));

    document.body.appendChild(scr);
    const layer = pushLayer({
      canClose: () => {
        if (pages.length || photo) { setTimeout(askDiscard); return false; }
        return true;
      },
      onClose: () => {
        if (photo && photo.bitmap) photo.bitmap.close();
        scr.remove();
        window.removeEventListener("resize", layout);
        resolve(result);
      }
    });

    async function askDiscard() {
      const n = pages.length + (photo ? 1 : 0);
      const ok = await confirmDialog({
        title: `Discard ${n === 1 ? "this page" : `these ${n} pages`}?`,
        message: "The pages you've scanned won't be kept.",
        okText: "Discard",
        danger: true
      });
      if (ok) { pages.length = 0; photo = null; closeLayer(layer); }
    }
    $("[data-close]").addEventListener("click", () => {
      if (pages.length || photo) askDiscard();
      else closeLayer(layer);
    });

    function showStart() {
      photo = null;
      $("[data-start]").hidden = false;
      $("[data-edit]").hidden = true;
      $("[data-foot]").hidden = true;
      $("[data-title]").textContent = pages.length ? `Page ${pages.length + 1}` : "Scan pages";
      $("[data-ready]").hidden = !pages.length;
      $("[data-count]").textContent = `${pages.length} page${pages.length === 1 ? "" : "s"} scanned`;
    }

    async function getPhoto(useCamera) {
      const files = await pickFiles(useCamera ? { accept: "image/*", capture: "environment" } : { accept: "image/*" });
      if (!files.length) return;
      const b = busy("Finding the page…");
      try {
        let bitmap;
        try {
          bitmap = await createImageBitmap(files[0], { imageOrientation: "from-image" });
        } catch (e) {
          toast("That photo couldn't be read. If it's a HEIC photo, set the camera to JPEG.", { ms: 6000 });
          return;
        }
        const k = Math.min(1, MAX_SOURCE / Math.max(bitmap.width, bitmap.height));
        const w = Math.round(bitmap.width * k);
        const hh = Math.round(bitmap.height * k);
        const oc = new OffscreenCanvas(w, hh);
        const ctx = oc.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(bitmap, 0, 0, w, hh);
        const rgba = ctx.getImageData(0, 0, w, hh).data;
        let corners = null;
        try { corners = findPage(rgba, w, hh); } catch (e) { console.warn(e); }
        if (!corners) {
          const m = 0.06;
          corners = [{ x: w * m, y: hh * m }, { x: w * (1 - m), y: hh * m }, { x: w * (1 - m), y: hh * (1 - m) }, { x: w * m, y: hh * (1 - m) }];
        }
        if (photo && photo.bitmap) photo.bitmap.close();
        photo = { rgba, w, h: hh, bitmap, corners };
        $("[data-start]").hidden = true;
        $("[data-edit]").hidden = false;
        $("[data-foot]").hidden = false;
        $("[data-title]").textContent = `Page ${pages.length + 1}`;
        await nextFrame();
        layout();
      } finally {
        b.close();
      }
    }
    $("[data-take]").addEventListener("click", () => getPhoto(true));
    $("[data-pick]").addEventListener("click", () => getPhoto(false));
    $("[data-retake]").addEventListener("click", () => getPhoto(true));

    // Fit the photo in the stage, leaving room around it for the corner handles.
    let view = { s: 1, ox: 0, oy: 0 };
    function layout() {
      if (!photo) return;
      const r = stage.getBoundingClientRect();
      const pad = 28;
      const s = Math.min((r.width - 2 * pad) / photo.w, (r.height - 2 * pad) / photo.h);
      const dw = photo.w * s, dh = photo.h * s;
      view = { s, ox: (r.width - dw) / 2, oy: (r.height - dh) / 2 };
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(dw * dpr);
      canvas.height = Math.round(dh * dpr);
      Object.assign(canvas.style, { left: view.ox + "px", top: view.oy + "px", width: dw + "px", height: dh + "px" });
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(photo.bitmap, 0, 0, canvas.width, canvas.height);
      svg.setAttribute("width", r.width);
      svg.setAttribute("height", r.height);
      drawQuad();
    }
    window.addEventListener("resize", layout);
    const toScreen = (p) => ({ x: view.ox + p.x * view.s, y: view.oy + p.y * view.s });
    function drawQuad() {
      const pts = photo.corners.map(toScreen);
      poly.setAttribute("points", pts.map((p) => `${p.x},${p.y}`).join(" "));
      pts.forEach((p, i) => { handles[i].setAttribute("cx", p.x); handles[i].setAttribute("cy", p.y); });
    }

    // Dragging a corner, with a magnifier above your finger so you can see the exact edge.
    let drag = null;
    svg.addEventListener("pointerdown", (e) => {
      if (!photo) return;
      const r = stage.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = -1, bestD = 48;
      photo.corners.forEach((c, i) => {
        const p = toScreen(c);
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best < 0) return;
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      const p = toScreen(photo.corners[best]);
      drag = { i: best, dx: p.x - x, dy: p.y - y };
      handles[best].classList.add("on");
      moveLoupe(best);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const r = stage.getBoundingClientRect();
      const sx = e.clientX - r.left + drag.dx, sy = e.clientY - r.top + drag.dy;
      photo.corners[drag.i] = {
        x: Math.min(photo.w, Math.max(0, (sx - view.ox) / view.s)),
        y: Math.min(photo.h, Math.max(0, (sy - view.oy) / view.s))
      };
      drawQuad();
      moveLoupe(drag.i);
    });
    const endDrag = () => {
      if (!drag) return;
      handles[drag.i].classList.remove("on");
      drag = null;
      loupe.hidden = true;
    };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);

    function moveLoupe(i) {
      const c = photo.corners[i];
      const p = toScreen(c);
      const size = 120;
      const zoom = 2.5;
      loupe.hidden = false;
      // Sit above the finger, or below it near the top of the screen.
      const top = p.y - size - 46 < 0 ? p.y + 46 : p.y - size - 46;
      Object.assign(loupe.style, { left: Math.min(Math.max(4, p.x - size / 2), stage.clientWidth - size - 4) + "px", top: top + "px" });
      const ctx = loupe.getContext("2d");
      const L = loupe.width;
      const srcSpan = (size / zoom) / view.s; // photo pixels shown across the loupe
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, L, L);
      const bk = photo.bitmap.width / photo.w;
      ctx.drawImage(photo.bitmap, (c.x - srcSpan / 2) * bk, (c.y - srcSpan / 2) * bk, srcSpan * bk, srcSpan * bk, 0, 0, L, L);
      // The corner's two edges, then a crosshair at the corner.
      const toL = (q) => ({ x: L / 2 + (q.x - c.x) * (L / srcSpan), y: L / 2 + (q.y - c.y) * (L / srcSpan) });
      const prev = toL(photo.corners[(i + 3) % 4]), next = toL(photo.corners[(i + 1) % 4]);
      ctx.strokeStyle = "#5b9bd5";
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(L / 2, L / 2); ctx.lineTo(next.x, next.y); ctx.stroke();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(L / 2 - 14, L / 2); ctx.lineTo(L / 2 + 14, L / 2); ctx.moveTo(L / 2, L / 2 - 14); ctx.lineTo(L / 2, L / 2 + 14); ctx.stroke();
    }

    // Straighten and clean the page on screen, and keep it.
    async function keepPhoto() {
      if (!photo) return true;
      const b = busy("Straightening the page…");
      try {
        await nextFrame();
        const { W, H } = outputSize(photo.corners);
        const flat = straighten(photo.rgba, photo.w, photo.h, photo.corners, W, H);
        const px = cleanUp(flat, W, H, filter);
        const oc = new OffscreenCanvas(W, H);
        oc.getContext("2d").putImageData(new ImageData(px, W, H), 0, 0);
        const blob = await oc.convertToBlob({ type: "image/jpeg", quality: filter === "original" ? 0.88 : 0.85 });
        pages.push(new File([blob], `Scan page ${pages.length + 1}.jpg`, { type: "image/jpeg" }));
        photo.bitmap.close();
        photo = null;
        return true;
      } catch (e) {
        console.error(e);
        toast("That page couldn't be straightened. Try again.", { ms: 5000 });
        return false;
      } finally {
        b.close();
      }
    }
    $("[data-next]").addEventListener("click", async () => {
      if (await keepPhoto()) showStart();
    });
    const finish = async () => {
      if (!(await keepPhoto())) return;
      result = pages.slice();
      pages.length = 0;
      closeLayer(layer);
    };
    $("[data-finish]").addEventListener("click", finish);
    $("[data-finish-start]").addEventListener("click", finish);

    showStart();
  });
}
