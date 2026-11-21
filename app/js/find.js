// Find text: a bar in place of the top bar. Looks through the file's own text and through text
// recognised on scanned pages, highlights every match on the pages shown, and steps through them.
import { h, icon, pushLayer, closeLayer } from "./ui.js";
import { fileOcrPages } from "./ocrlayer.js";

let open = null; // the bar that is open: { close(), refresh() }

export function findIsOpen() {
  return !!open;
}

/** Closes the bar if it is open. */
export function closeFind() {
  if (open) open.close();
}

/** The document changed (pages added, removed, text recognised): search again. */
export function findDocChanged() {
  if (open) open.refresh();
}

// Text as it is searched: lower case, any run of spaces or line breaks as one space.
function normalised(strs) {
  let text = "";
  const at = []; // for each character of text: item, then offset in that item
  let space = true;
  strs.forEach((str, i) => {
    for (let j = 0; j < str.length; j++) {
      let c = str[j];
      if (/\s/.test(c)) {
        if (space) continue;
        c = " ";
        space = true;
      } else space = false;
      for (const x of c.toLowerCase()) { text += x; at.push(i, j); }
    }
  });
  return { text, at };
}

function normalQuery(q) {
  return q.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The searchable text of a page, item by item in the order of its text layer's spans. */
async function pageText(doc, p) {
  const s = doc.src(p);
  const ocr = !p.hideOcr && s.ocr && s.ocr[p.index];
  if (ocr && ocr.words.length) return ocr.words.map((w) => w.t + " ");
  if (s.kind !== "pdf" || !s.pdf) return null;
  if (p.dropOcr && (await fileOcrPages(s)).has(p.index)) return null;
  const page = await s.pdf.getPage(p.index + 1);
  const tc = await page.getTextContent();
  // pdf.js's text layer makes one span for each item that has a string
  return tc.items.filter((it) => it.str !== undefined).map((it) => it.str + (it.hasEOL ? "\n" : ""));
}

/**
 * Opens the find bar. host: the document screen; viewer: the page view.
 */
export function openFind({ host, viewer, doc, before }) {
  if (open) { open.focus(); return; }
  const bar = h(`<div class="topbar findbar" role="search">
    <button class="ib" type="button" data-close aria-label="Close find">${icon("back")}</button>
    <label class="find-field">${icon("search")}<input type="search" placeholder="Find in this file" aria-label="Find text" enterkeyhint="search" autocomplete="off" spellcheck="false"></label>
    <span class="find-count" aria-live="polite"></span>
    <button class="ib" type="button" data-prev aria-label="Previous match" disabled>${icon("chevup")}</button>
    <button class="ib" type="button" data-next aria-label="Next match" disabled>${icon("chevdown")}</button>
  </div>`);
  const input = bar.querySelector("input");
  const count = bar.querySelector(".find-count");
  const prevBtn = bar.querySelector("[data-prev]");
  const nextBtn = bar.querySelector("[data-next]");
  before.after(bar);
  host.classList.add("find-open");

  const cache = new Map(); // page key -> { text, at } (null: no text)
  let matches = []; // { key, i0, j0, i1, j1 }
  let current = -1;
  let run = 0;
  let pendingScroll = null; // key of a page whose match should come into view once its text is there
  let timer = 0;

  const supportsHighlights = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight === "function";

  function rangeOf(it, m) {
    const divs = it.text && it.text.divs;
    if (!divs) return null;
    const a = divs[m.i0] && divs[m.i0].firstChild;
    const b = divs[m.i1] && divs[m.i1].firstChild;
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a, Math.min(m.j0, a.length));
      r.setEnd(b, Math.min(m.j1, b.length));
    } catch (e) {
      return null;
    }
    return r;
  }

  function paint() {
    if (supportsHighlights) {
      const all = [], now = [];
      for (const it of viewer.items) {
        if (!it.text || !it.text.divs) continue;
        matches.forEach((m, k) => {
          if (m.key !== it.p.key) return;
          const r = rangeOf(it, m);
          if (r) (k === current ? now : all).push(r);
        });
      }
      CSS.highlights.set("tpt-find", new Highlight(...all));
      CSS.highlights.set("tpt-find-now", new Highlight(...now));
    } else {
      document.querySelectorAll(".find-hit").forEach((e) => e.classList.remove("find-hit", "now"));
      for (const it of viewer.items) {
        if (!it.text || !it.text.divs) continue;
        matches.forEach((m, k) => {
          if (m.key !== it.p.key) return;
          for (let i = m.i0; i <= m.i1; i++) if (it.text.divs[i]) it.text.divs[i].classList.add("find-hit", ...(k === current ? ["now"] : []));
        });
      }
    }
  }

  function clearPaint() {
    if (supportsHighlights) { CSS.highlights.delete("tpt-find"); CSS.highlights.delete("tpt-find-now"); }
    document.querySelectorAll(".find-hit").forEach((e) => e.classList.remove("find-hit", "now"));
  }

  function showCount(searching, done, total) {
    const q = normalQuery(input.value);
    if (!q) count.textContent = "";
    else if (searching) count.textContent = matches.length ? `${matches.length}…` : `${done}/${total}`;
    else count.textContent = matches.length ? `${current + 1} of ${matches.length}` : "None";
    count.classList.toggle("none", !searching && !!q && !matches.length);
    prevBtn.disabled = nextBtn.disabled = !matches.length;
  }

  function bringIntoView(it, m) {
    const r = rangeOf(it, m);
    const root = viewer.root;
    const rr = root.getBoundingClientRect();
    const box = r ? r.getBoundingClientRect() : (it.text && it.text.divs[m.i0] ? it.text.divs[m.i0].getBoundingClientRect() : null);
    if (!box || (!box.width && !box.height)) return;
    const cy = box.top + box.height / 2, cx = box.left + box.width / 2;
    if (cy < rr.top + 60 || cy > rr.bottom - 60) root.scrollTop += cy - (rr.top + rr.height * 0.4);
    if (cx < rr.left + 20 || cx > rr.right - 20) root.scrollLeft += cx - (rr.left + rr.width / 2);
  }

  function goTo(k) {
    if (!matches.length) return;
    current = (k + matches.length) % matches.length;
    const m = matches[current];
    const idx = doc.pages.findIndex((p) => p.key === m.key);
    const it = viewer.items[idx];
    if (it && it.text && it.text.divs) bringIntoView(it, m);
    else {
      pendingScroll = m.key;
      viewer.scrollToPage(idx);
    }
    paint();
    showCount(false);
  }

  async function search() {
    const id = ++run;
    const q = normalQuery(input.value);
    matches = [];
    current = -1;
    clearPaint();
    if (!q) { showCount(false); return; }
    const start = viewer.currentIndex();
    const pages = doc.pages.slice();
    for (let n = 0; n < pages.length; n++) {
      const p = pages[n];
      let t = cache.get(p.key);
      if (t === undefined) {
        try {
          const strs = await pageText(doc, p);
          t = strs ? normalised(strs) : null;
        } catch (e) {
          t = null;
        }
        if (id !== run) return;
        cache.set(p.key, t);
      }
      if (t) {
        let from = 0;
        for (;;) {
          const i = t.text.indexOf(q, from);
          if (i < 0) break;
          const e = i + q.length - 1;
          matches.push({ key: p.key, i0: t.at[2 * i], j0: t.at[2 * i + 1], i1: t.at[2 * e], j1: t.at[2 * e + 1] + 1 });
          if (current < 0 && n >= start) current = matches.length - 1;
          from = i + q.length;
        }
      }
      if (n % 8 === 7) showCount(true, n + 1, pages.length);
    }
    if (id !== run) return;
    if (matches.length) goTo(current < 0 ? 0 : current);
    else { paint(); showCount(false); }
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    clearTimeout(timer);
    if (current < 0 && normalQuery(input.value)) { search(); return; }
    goTo(current + (e.shiftKey ? -1 : 1));
  });
  prevBtn.addEventListener("click", () => goTo(current - 1));
  nextBtn.addEventListener("click", () => goTo(current + 1));

  const prevOnText = viewer.onText;
  viewer.onText = (it) => {
    if (prevOnText) prevOnText(it);
    if (!matches.length) return;
    paint();
    if (pendingScroll === it.p.key && current >= 0 && matches[current].key === it.p.key) {
      pendingScroll = null;
      bringIntoView(it, matches[current]);
    }
  };

  let layer = null;
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    run++;
    clearTimeout(timer);
    clearPaint();
    viewer.onText = prevOnText;
    bar.remove();
    host.classList.remove("find-open");
    open = null;
    if (layer) { const l = layer; layer = null; closeLayer(l); }
  }
  layer = pushLayer({ onClose: () => { layer = null; close(); } });
  bar.querySelector("[data-close]").addEventListener("click", () => close());

  open = {
    close,
    focus: () => { input.focus(); input.select(); },
    refresh: () => { cache.clear(); if (normalQuery(input.value)) search(); }
  };
  setTimeout(() => input.focus(), 50);
  return open;
}
