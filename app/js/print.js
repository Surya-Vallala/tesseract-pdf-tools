// Print what you see: the layers that are on, your drawings and pictures, and comments if they
// are shown. In the Android app the PDF itself goes to Android's print screen; in Chrome the pages
// are drawn as pictures (150 dpi) for Chrome's print screen. Either offers Save as PDF too.
import { h, esc, segmented, openSheet, toast, busy } from "./ui.js";
import { buildPdf } from "./save.js";
import { engine, preloadEngine } from "./engine.js";
import { isNative, printPdf } from "./native.js";

let area = null; // pictures waiting for Chrome's print screen

function clearArea() {
  if (!area) return;
  for (const u of area.urls) URL.revokeObjectURL(u);
  area.el.remove();
  area = null;
}

export function openPrint(ctx) {
  const doc = ctx.doc();
  if (!isNative) preloadEngine();
  const n = doc.pages.length;
  const current = doc.pages[Math.max(0, Math.min(n - 1, ctx.currentIndex()))];
  const selected = ctx.selectedPages();
  let mode = n > 1 && selected.length > 1 ? "sel" : "all";
  const opts = [{ value: "all", label: n > 1 ? `All ${n} pages` : "The page" }];
  if (n > 1) opts.push({ value: "this", label: `Page ${doc.pages.indexOf(current) + 1}` });
  if (n > 1 && selected.length > 1) opts.push({ value: "sel", label: `${selected.length} selected` });
  const comments = doc.commentsVisible && doc.pages.some((p) => p.items.some((it) => it.kind === "comment"));
  const body = h(`<div>
    ${n > 1 ? `<div class="field"><span>Pages</span><div data-pages></div></div>` : ""}
    <ul class="save-notes">
      <li>${esc(`It prints what you see: the layers that are on and your drawings${comments ? ", and comments" : ""}.`)}</li>
      <li>${esc(isNative ? "Next, choose a printer, or Save as PDF." : "Next, choose a printer, or Save as PDF, in Chrome's print screen.")}</li>
    </ul></div>`);
  if (n > 1) body.querySelector("[data-pages]").appendChild(segmented(opts, mode, (v) => { mode = v; }, { small: true, label: "Pages" }));
  const foot = h(`<div class="foot-row"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="button" data-ok>Print</button></div>`);
  const sheet = openSheet({ title: "Print", body, foot });
  foot.querySelector("[data-cancel]").addEventListener("click", () => sheet.close());
  foot.querySelector("[data-ok]").addEventListener("click", async () => {
    const list = mode === "this" ? [current] : mode === "sel" ? selected : doc.pages;
    sheet.close();
    const b = busy("Getting the pages ready…");
    try {
      const { bytes, blurs, overlays } = await buildPdf(doc, list, { layers: "visible", comments, title: doc.name });
      let pdf = bytes;
      if (blurs.length) pdf = await engine("finalize", [bytes, { blurs, overlays, password: null }], { onProgress: (t) => b.set(t), transfer: [bytes.buffer] });
      if (isNative) {
        await printPdf(new File([pdf], `${doc.name}.pdf`, { type: "application/pdf" }), list.length);
        b.close();
        return;
      }
      const pics = await engine("render", [pdf, { dpi: 150, maxPx: 3500, format: "jpeg", quality: 88 }], {
        onProgress: (t) => b.set(t.replace("picture", "page")), transfer: [pdf.buffer]
      });
      b.set("Opening the print screen…");
      await printPictures(pics, doc.name);
      b.close();
    } catch (e) {
      b.close();
      console.error(e);
      toast(e && e.code === "offline" ? e.message : "Printing didn't work. Try again, or print fewer pages.", { ms: 6000 });
    }
  });
}

/** Chrome: each page as a picture on a sheet of its own size, then the print screen. */
async function printPictures(pics, title) {
  clearArea();
  const el = document.createElement("div");
  el.id = "printArea";
  const urls = [];
  const sizes = new Map();
  let html = "";
  for (const p of pics) {
    const w = +(p.pw || p.w * 0.48).toFixed(2), hh = +(p.ph || p.h * 0.48).toFixed(2);
    const key = `tpt${Math.round(w)}x${Math.round(hh)}`;
    sizes.set(key, [w, hh]);
    const url = URL.createObjectURL(new Blob([p.bytes], { type: "image/jpeg" }));
    urls.push(url);
    html += `<div class="print-page" style="page:${key};width:${w}pt;height:${hh}pt"><img src="${url}" alt=""></div>`;
  }
  let css = "";
  for (const [key, [w, hh]] of sizes) css += `@page ${key} { size: ${w}pt ${hh}pt; margin: 0; }\n`;
  el.innerHTML = `<style>${css}</style>${html}`;
  document.body.appendChild(el);
  area = { el, urls };
  await Promise.all([...el.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
  const old = document.title;
  document.title = title; // Chrome suggests it as the file name for Save as PDF
  // Android's print screen may draw the pages again while it is open (another paper size), so the
  // pictures stay a while after Chrome says printing is done.
  window.addEventListener("afterprint", () => { document.title = old; const mine = area; setTimeout(() => { if (area === mine) clearArea(); }, 120000); }, { once: true });
  window.print();
}
