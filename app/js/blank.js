/* Add blank pages: the size of any page in the file, a standard sheet or a custom size (mm),
   portrait or landscape, where they go and how many. Same choices as the Windows app. */
import { h, esc, openSheet, segmented, toast } from "./ui.js";
import { blankSource } from "./doc.js";

const MM = 72 / 25.4;
const MIN_MM = 10;
const MAX_MM = 5080; // the largest page a PDF allows (14,400 points)
const KEY = "tpt-blank"; // the standard sheet and custom size last used

/** The standard sheets, portrait, in mm. */
export const SHEETS = [
  ["A0", 841, 1189], ["A1", 594, 841], ["A2", 420, 594], ["A3", 297, 420], ["A4", 210, 297], ["A5", 148, 210],
  ["Letter", 215.9, 279.4], ["Legal", 215.9, 355.6], ["Tabloid", 279.4, 431.8]
];

/** "A3 landscape" when w × h (mm) is within 1 mm of a standard sheet, else "". */
export function sheetName(w, hh) {
  const a = Math.min(w, hh), b = Math.max(w, hh);
  for (const [name, x, y] of SHEETS) {
    if (Math.abs(a - x) <= 1 && Math.abs(b - y) <= 1) return `${name} ${w > hh ? "landscape" : "portrait"}`;
  }
  return "";
}

function remembered() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { std: typeof v.std === "string" ? v.std : "A4", w: +v.w > 0 ? +v.w : 210, h: +v.h > 0 ? +v.h : 297 };
  } catch (e) {
    return { std: "A4", w: 210, h: 297 };
  }
}

function remember(v) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* private mode */ }
}

const r0 = (v) => String(Math.round(v));
const r1 = (v) => String(Math.round(v * 10) / 10);
const num = (v) => parseFloat(String(v).replace(",", "."));

/**
 * Open the Add blank pages sheet.
 * anchor: the page "after / before page N" refers to (or null); where: the starting choice ("after" or "end");
 * onAdded(pages): called with the new pages after they are added.
 */
export function openBlankPages(doc, { anchor = null, where = "after", onAdded } = {}) {
  const pages = doc.pages.slice();
  if (anchor && !pages.includes(anchor)) anchor = null;
  const n = anchor ? pages.indexOf(anchor) + 1 : 0;
  const sizeOf = (i) => { const s = doc.pageSize(pages[i]); return [s.w / MM, s.h / MM]; };
  const mem = remembered();
  const body = h(`<form class="blank-form" autocomplete="off">
    <div class="blank-top"><div class="blank-shape"><div class="blank-paper"></div></div>
      <div class="blank-what"><b></b><span></span></div></div>
    <div class="field"><span>Size</span><div data-mode></div></div>
    <label class="field" data-pane="same"><span>Same as</span><select class="input" name="page"></select></label>
    <label class="field" data-pane="std" hidden><span>Sheet</span><select class="input" name="std"></select></label>
    <div class="blank-row" data-pane="custom" hidden>
      <label class="field"><span>Width (mm)</span><input class="input" name="w" inputmode="decimal"></label>
      <label class="field"><span>Height (mm)</span><input class="input" name="h" inputmode="decimal"></label></div>
    <div class="field"><span>Turn</span><div data-turn></div></div>
    <label class="field"><span>Where</span><select class="input" name="where"></select></label>
    <div class="field"><span>How many</span><div class="stepper blank-count"><button type="button" aria-label="Fewer pages">−</button><input name="count" inputmode="numeric" value="1" aria-label="How many pages"><button type="button" aria-label="More pages">+</button></div></div>
    <p class="form-error" hidden></p></form>`);
  const f = body;
  pages.forEach((p, i) => {
    const [w, hh] = sizeOf(i);
    const nm = sheetName(w, hh);
    f.page.appendChild(h(`<option value="${i}">Page ${i + 1} · ${r0(w)} × ${r0(hh)} mm${nm ? ` (${esc(nm.split(" ")[0])})` : ""}</option>`));
  });
  for (const [name, x, y] of SHEETS) f.std.appendChild(h(`<option value="${esc(name)}">${esc(name)} · ${r1(x)} × ${r1(y)} mm</option>`));
  f.std.value = SHEETS.some((s) => s[0] === mem.std) ? mem.std : "A4";
  f.w.value = r1(mem.w);
  f.h.value = r1(mem.h);
  const wh = [];
  if (anchor) wh.push(["after", `After page ${n}`], ["before", `Before page ${n}`]);
  wh.push(["start", "At the start"], ["end", "At the end"]);
  for (const [v, label] of wh) f.where.appendChild(h(`<option value="${v}">${esc(label)}</option>`));
  f.where.value = anchor ? where : "end";

  let mode = pages.length ? "same" : "std";
  let flipSame = false;
  const a0 = anchor ? sizeOf(n - 1) : pages.length ? sizeOf(0) : [210, 297];
  let stdLand = a0[0] > a0[1]; // standard sheets start turned like the page they go next to
  f.page.value = String(anchor ? n - 1 : 0);

  const size = () => {
    if (mode === "same") {
      const [w, hh] = sizeOf(+f.page.value);
      return flipSame ? [hh, w] : [w, hh];
    }
    if (mode === "std") {
      const s = SHEETS.find((x) => x[0] === f.std.value) || SHEETS[4];
      return stdLand ? [s[2], s[1]] : [s[1], s[2]];
    }
    return [num(f.w.value), num(f.h.value)];
  };

  const modeSeg = segmented([{ value: "same", label: "Same as page" }, { value: "std", label: "Standard" }, { value: "custom", label: "Custom" }],
    mode, (v) => { mode = v; paint(); }, { label: "Size" });
  if (!pages.length) modeSeg.querySelector('[data-v="same"]').disabled = true;
  f.querySelector("[data-mode]").appendChild(modeSeg);
  const turnSeg = segmented([{ value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" }], "", (v) => turn(v === "landscape"), { label: "Turn" });
  f.querySelector("[data-turn]").appendChild(turnSeg);

  function turn(land) {
    if (mode === "same") {
      const [w, hh] = sizeOf(+f.page.value);
      flipSame = (w > hh) !== land && Math.abs(w - hh) > 0.01;
    } else if (mode === "std") {
      stdLand = land;
    } else {
      const w = num(f.w.value), hh = num(f.h.value);
      if (w > 0 && hh > 0 && (w > hh) !== land && Math.abs(w - hh) > 0.01) { f.w.value = r1(hh); f.h.value = r1(w); }
    }
    paint();
  }

  const shape = f.querySelector(".blank-paper");
  const what = f.querySelector(".blank-what");
  function paint() {
    for (const el of f.querySelectorAll("[data-pane]")) el.hidden = el.dataset.pane !== mode;
    const [w, hh] = size();
    const ok = w > 0 && hh > 0;
    turnSeg.setValue(!ok || Math.abs(w - hh) < 0.01 ? "" : w > hh ? "landscape" : "portrait");
    if (ok) {
      const k = 64 / Math.max(w, hh);
      shape.style.width = `${Math.max(8, w * k)}px`;
      shape.style.height = `${Math.max(8, hh * k)}px`;
    }
    what.querySelector("b").textContent = ok ? `${r0(w)} × ${r0(hh)} mm` : "Type a size";
    what.querySelector("span").textContent = ok ? sheetName(w, hh) : "";
  }
  f.page.addEventListener("change", () => { flipSame = false; paint(); });
  f.std.addEventListener("change", paint);
  f.w.addEventListener("input", paint);
  f.h.addEventListener("input", paint);

  const cnt = f.count;
  const [minus, plus] = f.querySelectorAll(".blank-count button");
  const setCount = (v) => { cnt.value = String(Math.max(1, Math.min(100, Math.round(v) || 1))); };
  minus.addEventListener("click", () => setCount(num(cnt.value) - 1));
  plus.addEventListener("click", () => setCount(num(cnt.value) + 1));
  cnt.addEventListener("blur", () => setCount(num(cnt.value)));

  const foot = h(`<div class="foot-row"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn primary" data-ok>Add</button></div>`);
  const sheet = openSheet({ title: "Add blank pages", body, foot });
  foot.querySelector("[data-cancel]").addEventListener("click", () => sheet.close());
  const err = f.querySelector(".form-error");
  const submit = () => {
    const [w, hh] = size();
    if (!(w >= MIN_MM && hh >= MIN_MM && w <= MAX_MM && hh <= MAX_MM)) {
      err.textContent = `Type a width and height in mm, from ${MIN_MM} to ${MAX_MM}.`;
      err.hidden = false;
      return;
    }
    const count = Math.max(1, Math.min(100, Math.round(num(cnt.value)) || 1));
    remember({ std: f.std.value, w: num(f.w.value) > 0 ? num(f.w.value) : mem.w, h: num(f.h.value) > 0 ? num(f.h.value) : mem.h });
    const v = f.where.value;
    const at = v === "start" ? 0 : v === "end" ? doc.pages.length
      : doc.pages.indexOf(anchor) + (v === "after" ? 1 : 0);
    sheet.close();
    doc.commit();
    const added = [];
    for (let i = 0; i < count; i++) added.push(...doc.addSource(blankSource(w * MM, hh * MM), at + i));
    doc.changed({ added: true });
    const nm = sheetName(w, hh);
    toast(`Added ${count} blank page${count === 1 ? "" : "s"} · ${nm || `${r0(w)} × ${r0(hh)} mm`}`);
    onAdded && onAdded(added);
  };
  foot.querySelector("[data-ok]").addEventListener("click", submit);
  f.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  paint();
  return sheet;
}
