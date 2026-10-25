// Tesseract PDF Tools - phone app
import { Doc, loadSource, baseName, closeSource, unlockSource, blankSource } from "./doc.js";
import { Viewer } from "./viewer.js";
import { PageGrid } from "./pages.js";
import { openCrop } from "./crop.js";
import { openLayers, pickDrawingLayer } from "./layers.js";
import { openSaveSheet, formatSize } from "./save.js";
import { Markup } from "./markup.js";
import { askAuthor, openBubble, openCommentsList, editComment } from "./comments.js";
import { openTools, openPageImages } from "./tools.js";
import { engine } from "./engine.js";
import { importDrawings, syncSketchVisibility, applyCommentVisibility } from "./interop.js";
import { pickFiles, onIncomingFiles, isAndroidApp } from "./platform.js";
import { fetchUpdateInfo, installUpdate, newerThan } from "./native.js";
import { scanPages } from "./scan.js";
import { rememberFile, listRecent, recentFile, forgetRecent, clearRecent, when } from "./recent.js";
import { hydrateIcons, initHistory, pushLayer, closeLayer, confirmDialog, choiceDialog, passwordDialog, toast, busy, openMenu, openSheet, h, esc, icon } from "./ui.js";

const APP_VERSION = "1.8.2";
const $ = (id) => document.getElementById(id);

const home = $("home");
const docScreen = $("docScreen");

hydrateIcons();
initHistory();
// Blocks drawn by AI were taken out in 1.6: forget any Claude API key an earlier version kept here.
try { localStorage.removeItem("tpt-ai-key"); } catch (e) { /* private mode */ }
$("appVersion").textContent = APP_VERSION;

// Open files, one tab each. cur is the one on screen: { doc, tab, view }.
const MAX_TABS = 6;
const tabs = [];
let cur = null;
let pendingReload = false;
// One Back step per open file. The steps are interchangeable: Back always closes the file on screen.
const docLayers = [];
let closingTab = null;

const viewer = new Viewer($("viewer"), $("vwrap"), $("pageBadge"), {
  onTap: () => { if (cur && cur.tab === "view") docScreen.classList.toggle("immersive"); },
  onPage: (i) => { if (cur && cur.tab !== "pages") setMeta(`Page ${i + 1} of ${cur.doc.pages.length}`); },
  onPin: (page, id, el) => {
    if (!cur) return;
    if (cur.tab === "markup") {
      markup.setTool("select");
      markup.select({ key: page.key, id });
      return;
    }
    openBubble(cur.doc, page, id, el, marksChanged);
  }
});
const grid = new PageGrid($("pagesView"), $("grid"), {
  onSelection: (n) => updateSelectionUi(n)
});
const markup = new Markup({
  viewer,
  screen: docScreen,
  optbar: $("optbar"),
  toolbar: $("toolbar"),
  chip: $("layerChip"),
  views: $("views"),
  getDoc: () => (cur ? cur.doc : null),
  onChange: () => updateDocUi(),
  onComment: (action, key, id) => {
    const page = cur.doc.pages.find((p) => p.key === key);
    if (page && action === "edit") editComment(cur.doc, page, id, marksChanged);
  },
  askAuthor
});

function marksChanged() {
  viewer.marksChanged();
  markup.drawSelection();
  updateDocUi();
}

/* ---------- opening files ---------- */

$("btnOpen").addEventListener("click", () => openPicked());
async function openPicked() {
  const files = await pickFiles({ multiple: true });
  if (files.length) openFiles(files, { combine: false });
}
$("btnCombine").addEventListener("click", async () => {
  const files = await pickFiles({ multiple: true });
  if (files.length) openFiles(files, { combine: true });
});
$("btnScan").addEventListener("click", () => scanToNewTab());

/* ---------- recent files ---------- */

async function refreshRecentButton() {
  const list = await listRecent();
  $("btnRecent").hidden = !list.length;
  if (list.length) $("recentSub").textContent = `${list.length} file${list.length === 1 ? "" : "s"}. Last one ${list[0].how === "saved" ? "saved" : "opened"} ${when(list[0].at)}`;
}
window.addEventListener("tpt-recent", refreshRecentButton);
refreshRecentButton();
$("btnRecent").addEventListener("click", () => openRecentSheet());

async function openRecentSheet() {
  const list = await listRecent();
  if (!list.length) { toast("No recent files yet."); return; }
  const urls = [];
  const body = h(`<div><div class="recent-list"></div><p class="note">Copies of your last ${list.length > 1 ? "files" : "file"} are kept on this phone, so they open even if the original has moved. Up to 12 files.</p></div>`);
  const box = body.querySelector(".recent-list");
  const foot = h(`<div class="foot-row"><button class="btn" type="button" data-clear>Clear list</button><button class="btn primary" type="button" data-close>Close</button></div>`);
  const sheet = openSheet({ title: "Recent files", body, foot, onClose: () => urls.forEach((u) => URL.revokeObjectURL(u)) });
  for (const m of list) {
    const row = h(`<div class="recent-row">
      <button type="button" class="recent-open">
        <span class="recent-thumb">${m.thumb ? '<img alt="">' : icon(m.type.startsWith("image/") ? "image" : "file")}</span>
        <span class="recent-text"><b>${esc(m.name)}</b><small>${m.how === "saved" ? "Saved" : "Opened"} ${esc(when(m.at))} · ${formatSize(m.size)}</small></span>
      </button>
      <button type="button" class="ib recent-x" aria-label="Remove ${esc(m.name)} from the list">${icon("close")}</button>
    </div>`);
    if (m.thumb) {
      const u = URL.createObjectURL(m.thumb);
      urls.push(u);
      row.querySelector("img").src = u;
    }
    row.querySelector(".recent-open").addEventListener("click", async () => {
      const f = await recentFile(m.id);
      sheet.close();
      if (!f) { toast("That file isn't kept any more."); forgetRecent(m.id); return; }
      openFiles([f], { combine: false });
    });
    row.querySelector(".recent-x").addEventListener("click", async () => {
      await forgetRecent(m.id);
      row.remove();
      if (!box.children.length) sheet.close();
    });
    box.appendChild(row);
  }
  foot.querySelector("[data-close]").addEventListener("click", () => sheet.close());
  foot.querySelector("[data-clear]").addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Clear recent files?", message: "The copies kept on this phone are deleted. Your original files aren't touched.", okText: "Clear", danger: true });
    if (!ok) return;
    await clearRecent();
    sheet.close();
  });
}

// "Scan 15-10-2026 09.42"
function scanName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `Scan ${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

async function scanToNewTab() {
  if (tabs.length >= MAX_TABS) {
    toast(`Up to ${MAX_TABS} files can be open at once. Close one, then scan.`, { ms: 5000 });
    return;
  }
  const files = await scanPages();
  if (!files.length) return;
  // A new scan isn't saved anywhere yet, so closing it asks first.
  openFiles(files, { combine: true, name: scanName(), tab: files.length > 1 ? "pages" : "view", unsaved: true });
}

async function loadAll(files, { many }) {
  const loaded = [];
  const problems = [];
  let b = busy(files.length > 1 ? `Opening ${files.length} files…` : "Opening…");
  const askPassword = async (name, retry) => {
    b.close();
    const pw = await passwordDialog(name, retry);
    b = busy("Opening…");
    return pw;
  };
  for (let i = 0; i < files.length; i++) {
    if (files.length > 1) b.set(`Opening ${i + 1} of ${files.length}…`);
    try {
      const src = await loadSource(files[i], { askPassword });
      if (!src) continue;
      if (src.kind === "pdf" && src.encrypted) {
        b.set("Unlocking for editing…");
        try {
          const plain = await engine("unlock", [src.bytes.slice(), src.password || ""]);
          unlockSource(src, plain);
        } catch (e) {
          if (many) {
            problems.push(`“${src.name}” is password-protected and couldn't be unlocked here. ${e && e.code === "offline" ? "Connect to the internet once and try again." : ""}`);
            closeSource(src);
            continue;
          }
        }
      }
      loaded.push(src);
    } catch (e) {
      console.error(e);
      problems.push(e.message || `“${files[i].name}” couldn't be opened.`);
    }
  }
  b.close();
  return { loaded, problems };
}

// A file that's already open (same name and size) just comes to the front.
function findOpen(file) {
  return tabs.find((t) => {
    const srcs = [...t.doc.sources.values()];
    if (srcs.length !== 1) return false;
    const s = srcs[0];
    const size = s.blob ? s.blob.size : s.fileSize;
    return s.name === file.name && size === file.size;
  });
}

async function openFiles(files, { combine = false, name = null, tab = null, unsaved = false } = {}) {
  // Several files from "Open a PDF" open side by side, one tab each.
  if (!combine && files.length > 1) {
    for (const f of files) {
      if (!(await openFiles([f], { combine: false }))) break;
    }
    return true;
  }
  if (!combine) {
    const open = findOpen(files[0]);
    if (open) {
      activateTab(open);
      toast(`“${open.doc.name}.pdf” is already open`);
      return true;
    }
  }
  if (tabs.length >= MAX_TABS) {
    toast(`Up to ${MAX_TABS} files can be open at once. Close one, then try again.`, { ms: 5000 });
    return false;
  }
  const { loaded, problems } = await loadAll(files, { many: files.length > 1 });
  if (!loaded.length) {
    if (problems.length) confirmDialog({ title: "Couldn't open", message: problems.join("\n"), okText: "OK", cancelText: "" });
    return true;
  }
  const doc = new Doc();
  const added = loaded.map((s) => [s, doc.addSource(s)]);
  await bringDrawings(doc, added);
  doc.history = [];
  doc.dirty = unsaved;
  doc.name = name || (loaded.length === 1 ? baseName(loaded[0].name) : "Combined");
  if (loaded.length === 1 && loaded[0].kind === "pdf" && loaded[0].password) doc.password = loaded[0].password;
  openTab(doc, tab || (combine || loaded.length > 1 ? "pages" : "view"));
  if (!combine && !unsaved && files.length === 1) rememberFile(files[0], { doc });
  if (problems.length) toast(problems.join(" "), { ms: 6000 });
  if (doc.readOnly) toast("This PDF is password-protected. You can view it and turn layers on and off. To edit it, connect to the internet once and open it again.", { ms: 7000 });
  else if (doc.password) toast("This PDF has a password. Saved copies keep it. You can change it in Tools.", { ms: 5000 });
  return true;
}

async function addFiles(files) {
  if (!cur) return;
  const doc = cur.doc;
  const { loaded, problems } = await loadAll(files, { many: true });
  if (loaded.length) {
    const sel = grid.selectedPages();
    let at = sel.length ? doc.pages.indexOf(sel[sel.length - 1]) + 1 : doc.pages.length;
    doc.commit();
    let count = 0;
    const brought = [];
    for (const s of loaded) {
      const added = doc.addSource(s, at);
      brought.push([s, added]);
      at += added.length;
      count += added.length;
    }
    await bringDrawings(doc, brought);
    if (doc.sources.size > 1 && doc.name !== "Combined") doc.name = "Combined";
    doc.changed({ added: true });
    toast(`Added ${count} page${count === 1 ? "" : "s"}`);
  }
  if (problems.length) toast(problems.join(" "), { ms: 6000 });
}

// Drawings made in the Windows app (or saved here before) become marks you can edit.
async function bringDrawings(doc, pairs) {
  const b = pairs.some(([s]) => s.kind === "pdf" && !s.locked) ? busy("Reading drawings…") : null;
  try {
    for (const [s, pages] of pairs) {
      try { await importDrawings(doc, s, pages); } catch (e) { console.warn("Drawings could not be read", e); }
    }
  } finally {
    if (b) b.close();
  }
}

/* ---------- document screen ---------- */

function openTab(doc, tab) {
  const t = { doc, tab, view: null };
  tabs.push(t);
  doc.on("pages", () => {
    if (!cur || cur.doc !== doc) return;
    viewer.refresh();
    grid.refresh();
    markup.drawSelection();
    if (cur.tab === "markup") markup.renderOptions();
    updateDocUi();
  });
  pushDocLayer();
  activateTab(t);
}

function pushDocLayer() {
  const layer = pushLayer({
    canClose: () => {
      if (!cur) return true;
      if (cur.tab === "markup") {
        setTimeout(() => setTab("view"));
        return false;
      }
      if (cur.doc.dirty && cur.doc.pages.length) {
        setTimeout(() => leaveDoc());
        return false;
      }
      closingTab = cur;
      return true;
    },
    onClose: () => {
      const i = docLayers.indexOf(layer);
      if (i >= 0) docLayers.splice(i, 1);
      const t = closingTab || cur;
      closingTab = null;
      if (t) dropTab(t);
    }
  });
  docLayers.push(layer);
}

function activateTab(t) {
  if (!t || cur === t) return;
  if (cur) {
    if (cur.tab === "markup") { markup.exit(); cur.tab = "view"; }
    const v = viewer.saveState();
    if (v) cur.view = v;
  }
  cur = t;
  home.hidden = true;
  docScreen.hidden = false;
  docScreen.classList.remove("immersive");
  $("docTitle").textContent = t.doc.name + ".pdf";
  viewer.setDoc(t.doc, t.view);
  grid.setDoc(t.doc);
  const want = t.tab === "markup" ? "view" : t.tab || "view";
  t.tab = null;
  setTab(want);
  if (!t.tab) setTab("view");
  updateDocUi();
}

// Closes the file on screen, asking first if it has unsaved changes. Resolves true once closed.
async function leaveDoc() {
  if (!cur) return true;
  const doc = cur.doc;
  if (doc.dirty && doc.pages.length) {
    const v = await choiceDialog({
      title: "Save your changes?",
      message: `“${doc.name}.pdf” has changes that aren't saved yet.`,
      choices: [
        { label: "Cancel", value: null },
        { label: "Discard", value: "discard", kind: "danger-text" },
        { label: "Save", value: "save", kind: "primary" }
      ]
    });
    if (!v) return false;
    if (v === "save") {
      // Save first; the file closes once it has been saved or shared.
      openSaveSheet(doc, {
        onSaved: () => {
          updateDocUi();
          if (cur && cur.doc === doc && !doc.dirty) closeCurrent();
        }
      });
      return false;
    }
    doc.dirty = false;
  }
  if (cur && cur.doc === doc) closeCurrent();
  return true;
}

function closeCurrent() {
  if (!cur) return;
  if (cur.tab === "markup") { markup.exit(); cur.tab = "view"; }
  closingTab = cur;
  closeLayer(docLayers[docLayers.length - 1]);
}

// Lets go of a closed file and shows the one before it, or the home screen after the last.
function dropTab(t) {
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (cur === t) {
    if (cur.tab === "markup") markup.exit();
    viewer.hide();
    viewer.clear();
    grid.clear();
    cur = null;
  }
  for (const s of t.doc.sources.values()) closeSource(s);
  if (!cur && tabs.length) {
    activateTab(tabs[Math.max(0, i - 1)]);
    return;
  }
  if (!tabs.length) {
    docScreen.hidden = true;
    docScreen.classList.remove("mode-markup", "tab-pages", "tab-view");
    home.hidden = false;
    renderTabs();
    if (pendingReload) location.reload();
    return;
  }
  renderTabs();
}

/* ---------- the tab strip ---------- */

let stripKey = "";
function renderTabs() {
  const strip = $("docTabs");
  const many = tabs.length > 1;
  docScreen.classList.toggle("has-tabs", many);
  $("btnNewTab").hidden = many;
  const key = many ? tabs.map((t) => `${t === cur ? "*" : ""}${t.doc.dirty ? "~" : ""}${t.doc.name}`).join("|") : "";
  if (key === stripKey) return;
  stripKey = key;
  strip.hidden = !many;
  strip.textContent = "";
  if (!many) return;
  for (const t of tabs) {
    const on = t === cur;
    const el = h(`<div class="dtab${on ? " on" : ""}">
      <button type="button" class="dtab-name" role="tab" aria-selected="${on}">${t.doc.dirty ? '<i class="dtab-dot" aria-label="Not saved"></i>' : ""}<span>${esc(t.doc.name)}</span></button>
      ${on ? `<button type="button" class="dtab-x" aria-label="Close ${esc(t.doc.name)}">${icon("close")}</button>` : ""}
    </div>`);
    el.querySelector(".dtab-name").addEventListener("click", () => activateTab(t));
    const x = el.querySelector(".dtab-x");
    if (x) x.addEventListener("click", () => leaveDoc());
    strip.appendChild(el);
  }
  const plus = h(`<button type="button" class="dtab-add" aria-label="Open another file">${icon("plus")}</button>`);
  plus.addEventListener("click", () => openAnother(plus));
  strip.appendChild(plus);
  const on = strip.querySelector(".dtab.on");
  if (on) on.scrollIntoView({ inline: "nearest", block: "nearest" });
}

async function openAnother(anchor) {
  if (tabs.length >= MAX_TABS) {
    toast(`Up to ${MAX_TABS} files can be open at once. Close one first.`, { ms: 5000 });
    return;
  }
  const v = await openMenu(anchor, [
    { label: "Open a PDF", value: "open", icon: "file" },
    { label: "Recent files", value: "recent", icon: "clock" },
    { label: "Scan pages", value: "scan", icon: "scan" },
    { label: "Combine files", value: "combine", icon: "combine" }
  ]);
  if (v === "open") openPicked();
  else if (v === "recent") openRecentSheet();
  else if (v === "scan") scanToNewTab();
  else if (v === "combine") $("btnCombine").click();
}
$("btnNewTab").addEventListener("click", (e) => openAnother(e.currentTarget));

function setTab(tab) {
  if (!cur) return;
  const doc = cur.doc;
  if (doc.readOnly && (tab === "pages" || tab === "markup")) {
    toast("Password-protected PDFs can't be edited until they're unlocked. Connect to the internet once and open it again.", { ms: 5000 });
    return;
  }
  const was = cur.tab;
  if (was === "markup" && tab !== "markup") markup.exit();
  cur.tab = tab;
  document.querySelectorAll("#tabbar .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const inViewer = tab === "view" || tab === "markup";
  docScreen.classList.toggle("tab-view", inViewer);
  docScreen.classList.toggle("tab-pages", tab === "pages");
  docScreen.classList.toggle("mode-markup", tab === "markup");
  $("viewer").hidden = !inViewer;
  $("pagesView").hidden = inViewer;
  if (tab !== "view") docScreen.classList.remove("immersive");
  if (inViewer) {
    const sel = grid.selectedPages();
    viewer.show();
    if (was === "pages" && sel.length) viewer.scrollToPage(doc.pages.indexOf(sel[0]));
    if (tab === "markup") markup.enter();
  } else {
    viewer.hide();
    grid.layersChanged(); // drawings may have changed: thumbnails show them
  }
  updateDocUi();
}

function setMeta(text) {
  $("docMeta").textContent = text;
}

function updateDocUi() {
  if (!cur) return;
  const doc = cur.doc;
  const n = doc.pages.length;
  $("docTitle").textContent = doc.name + ".pdf";
  document.querySelectorAll("[data-undo]").forEach((b) => { b.disabled = !doc.history.length; });
  document.querySelectorAll("[data-redo]").forEach((b) => { b.disabled = !doc.future.length; });
  $("btnSave").disabled = !n;
  $("btnAddFiles").hidden = doc.readOnly;
  $("emptyDoc").hidden = n > 0;
  if (cur.tab === "pages") setMeta(`${n} page${n === 1 ? "" : "s"}`);
  else setMeta(n ? `Page ${viewer.currentIndex() + 1} of ${n}` : "No pages");
  const c = doc.comments().length;
  const chip = $("commentsChip");
  chip.hidden = !c;
  chip.lastElementChild.textContent = `${c} comment${c === 1 ? "" : "s"}`;
  updateSelectionUi(grid.selection.size);
  renderTabs();
}

function updateSelectionUi(count) {
  if (!cur) return;
  const inPages = cur.tab === "pages";
  $("selbar").hidden = !(inPages && count > 0);
  $("tabbar").hidden = inPages && count > 0;
  $("pagesInfo").textContent = count ? `${count} selected` : "Tap to select. Hold to drag.";
  $("btnSelAll").textContent = count ? "Clear" : "Select all";
}

$("tabbar").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b || !cur) return;
  const t = b.dataset.tab;
  if (t === "layers") {
    if (cur.tab === "pages") setTab("view");
    openLayers(cur.doc, {
      pdf: () => { viewer.layersChanged(); grid.layersChanged(); },
      marks: () => { syncSketchVisibility(cur.doc); viewer.layersChanged(); grid.layersChanged(); marksChanged(); markup.updateChip(); },
      comments: () => commentsToggled()
    });
    return;
  }
  if (t === "tools") {
    openTools(toolsCtx);
    return;
  }
  setTab(t);
});

const toolsCtx = {
  doc: () => (cur ? cur.doc : null),
  selectedPages: () => grid.selectedPages(),
  currentIndex: () => viewer.currentIndex(),
  marksChanged: () => marksChanged(),
  changed: () => updateDocUi(),
  textChanged: (pages) => {
    for (const p of pages) { const it = viewer.itemFor(p.key); if (it) viewer.dropText(it); }
    viewer.update(true);
  }
};

$("btnDone").addEventListener("click", () => setTab("view"));
$("layerChip").addEventListener("click", async (e) => {
  if (!cur || e.currentTarget.disabled) return;
  if (await pickDrawingLayer(cur.doc, e.currentTarget)) { syncSketchVisibility(cur.doc); viewer.layersChanged(); markup.updateChip(); marksChanged(); }
});
$("commentsChip").addEventListener("click", () => {
  if (!cur) return;
  openCommentsList(cur.doc, {
    onGo: (page) => { setTab("view"); viewer.scrollToPage(cur.doc.pages.indexOf(page)); },
    onChange: marksChanged,
    onToggle: () => commentsToggled()
  });
});

function commentsToggled() {
  if (!cur) return;
  const doc = cur.doc;
  viewer.layersChanged(); grid.layersChanged(); marksChanged();
  applyCommentVisibility(doc).then((changed) => {
    if (changed && cur && cur.doc === doc) { viewer.layersChanged(); grid.layersChanged(); }
  });
}

$("btnSelAll").addEventListener("click", () => grid.setAll(grid.selection.size === 0));
$("btnAddFiles").addEventListener("click", async (e) => {
  const v = await openMenu(e.currentTarget, [
    { label: "From files", value: "files", icon: "file" },
    { label: "Scan pages", value: "scan", icon: "scan" }
  ]);
  const files = v === "files" ? await pickFiles({ multiple: true }) : v === "scan" ? await scanPages() : [];
  if (files.length) addFiles(files);
});

$("selbar").addEventListener("click", async (e) => {
  const b = e.target.closest(".tab");
  if (!b || !cur) return;
  const doc = cur.doc;
  const sel = grid.selectedPages();
  if (!sel.length) return;
  switch (b.dataset.act) {
    case "rotl":
    case "rotr": {
      doc.commit();
      const d = b.dataset.act === "rotl" ? 270 : 90;
      for (const p of sel) p.rot = (p.rot + d) % 360;
      doc.changed({ rotate: true });
      break;
    }
    case "delete": {
      doc.commit();
      const gone = new Set(sel.map((p) => p.key));
      doc.pages = doc.pages.filter((p) => !gone.has(p.key));
      doc.changed({ delete: true });
      toast(`Deleted ${sel.length} page${sel.length === 1 ? "" : "s"}`, { action: { label: "Undo", fn: undo } });
      break;
    }
    case "crop":
      openCrop(doc, sel[0], sel, (pages, cropFor) => {
        doc.commit();
        for (const p of pages) p.crop = cropFor(p);
        doc.changed({ crop: true });
      });
      break;
    case "extract":
      openSaveSheet(doc, { pages: sel });
      break;
    case "more": {
      const v = await openMenu(b, [
        { label: "Save as pictures", value: "pics", icon: "pagepic" },
        { label: "Duplicate", value: "dup", icon: "copy" },
        { label: "Insert blank page after", value: "blank", icon: "blank" },
        { label: "Move to start", value: "start", icon: "tostart" },
        { label: "Move to end", value: "end", icon: "toend" }
      ], { above: true });
      if (!v) return;
      if (v === "pics") { openPageImages(toolsCtx, sel); return; }
      doc.commit();
      const keys = new Set(sel.map((p) => p.key));
      if (v === "dup") {
        const next = [];
        for (const p of doc.pages) {
          next.push(p);
          if (keys.has(p.key)) {
            const c = doc.newPage(p);
            c.items = c.items.map((it) => ({ ...it, id: it.id + "d" + c.key }));
            next.push(c);
          }
        }
        doc.pages = next;
        toast(`Duplicated ${sel.length} page${sel.length === 1 ? "" : "s"}`);
      } else if (v === "blank") {
        const last = sel[sel.length - 1];
        const ps = doc.pageSize(last);
        const src = blankSource(ps.w, ps.h);
        doc.addSource(src, doc.pages.indexOf(last) + 1);
        toast("Blank page added");
      } else if (v === "start" || v === "end") {
        const moving = doc.pages.filter((p) => keys.has(p.key));
        const rest = doc.pages.filter((p) => !keys.has(p.key));
        doc.pages = v === "start" ? [...moving, ...rest] : [...rest, ...moving];
      }
      doc.changed({ more: v });
      break;
    }
  }
});

// Undo and redo keep the selected mark selected when it still exists.
function keepSelection() {
  markup.select(markup.selectedItem() ? markup.sel : null);
}
function undo() {
  if (!cur) return;
  if (cur.doc.undo()) toast("Undone", { ms: 1500 });
  keepSelection();
}
function redo() {
  if (!cur) return;
  if (cur.doc.redo()) toast("Redone", { ms: 1500 });
  keepSelection();
}

document.querySelectorAll("[data-undo]").forEach((b) => b.addEventListener("click", undo));
document.querySelectorAll("[data-redo]").forEach((b) => b.addEventListener("click", redo));
$("btnSave").addEventListener("click", () => {
  if (!cur || !cur.doc.pages.length) return;
  openSaveSheet(cur.doc, { onSaved: () => updateDocUi() });
});
$("btnBack").addEventListener("click", () => { leaveDoc(); });
document.addEventListener("keydown", (e) => {
  if (!cur || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  else if ((k === "delete" || k === "backspace") && cur.tab === "markup" && markup.sel) { e.preventDefault(); markup.deleteSelected(); }
});
window.addEventListener("beforeunload", (e) => {
  if (tabs.some((t) => t.doc.dirty)) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------- files arriving from other apps ---------- */

onIncomingFiles((files, info) => {
  if (info && info.error) { toast("The shared file couldn't be read. Try again."); return; }
  if (!files.length) { if (info && info.shared) toast("Nothing arrived. Try sharing the file again."); return; }
  openFiles(files, { combine: files.length > 1 });
  if (info && info.partial) toast("Some of the shared files couldn't be read.");
});

/* ---------- install and updates ---------- */

const standalone = isAndroidApp || matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
$("shareTip").hidden = !standalone;
$("installCard").hidden = standalone;
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("btnInstall").hidden = false;
  $("installManual").hidden = true;
});
// The PDF engine needs a recent Chrome (or, in the Android app, Android System WebView).
if (typeof Promise.withResolvers !== "function") {
  const n = $("oldEngine");
  n.innerHTML = isAndroidApp
    ? "This phone's <b>Android System WebView</b> is out of date, so PDFs won't open. Update it in the Play Store, then open the app again."
    : "This version of <b>Chrome</b> is out of date, so PDFs won't open. Update Chrome in the Play Store, then open the app again.";
  n.hidden = false;
}

/* ---------- about: developed by Tesseract Studio ---------- */

const SUPPORT_EMAIL = "tools@tesseractstudio.co";
$("btnAbout").addEventListener("click", () => {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const subject = encodeURIComponent(`Tesseract PDF Tools (${isAndroidApp ? "Android app" : "phone"}) ${APP_VERSION}`);
  const body = h(`<div>
    <section class="about-card">
      <p class="lbl">Developed by</p>
      <img class="logo" src="icons/tesseract-logo-${dark ? "white" : "black"}.png" alt="Tesseract Design | Build">
      <p class="muted" style="font-size:15px">Tesseract Studio, Hyderabad</p>
    </section>
    <section class="about-card">
      <p class="lbl">Suggestions and questions</p>
      <p>Have an idea, found something wrong, or want to ask about the app? Write to us.</p>
      <a class="mail" href="mailto:${SUPPORT_EMAIL}?subject=${subject}">${SUPPORT_EMAIL}</a>
      <a class="btn primary" href="mailto:${SUPPORT_EMAIL}?subject=${subject}">Email Tesseract Studio</a>
    </section>
    ${isAndroidApp ? `<section class="about-card">
      <p class="lbl">Updates</p>
      <p>You have version ${APP_VERSION}. The app only goes online when you check.</p>
      <button class="btn" type="button" data-update>Check for updates</button>
    </section>` : ""}
    <p class="muted" style="text-align:center">Tesseract PDF Tools ${APP_VERSION}${isAndroidApp ? " for Android" : ""}</p>
  </div>`);
  const sheet = openSheet({ title: "About", body });
  const upd = body.querySelector("[data-update]");
  if (upd) upd.addEventListener("click", () => { sheet.close(); checkForUpdates(); });
});

/* ---------- Android app: check for updates, asking first every time ---------- */

async function checkForUpdates() {
  const ok = await confirmDialog({
    title: "Check for updates?",
    message: "This connects to the internet to see if there's a newer version of the app. None of your files are sent.",
    okText: "Check"
  });
  if (!ok) return;
  let info;
  const b = busy("Checking for updates…");
  try {
    info = await fetchUpdateInfo();
  } catch (e) {
    console.warn(e);
    toast("Couldn't check for updates. Check your internet connection and try again.", { ms: 6000 });
    return;
  } finally {
    b.close();
  }
  if (!newerThan(info.version, APP_VERSION)) {
    toast(`You have the latest version (${APP_VERSION}).`);
    return;
  }
  const notes = Array.isArray(info.notes) ? info.notes.slice(0, 8) : [];
  const body = h(`<div>
    <p style="margin-top:0">Version ${esc(info.version)} is ready${info.size_mb ? ` (${esc(String(info.size_mb))} MB)` : ""}. You have ${APP_VERSION}.</p>
    ${notes.length ? `<ul class="save-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    <p class="muted" style="font-size:13px">Android will ask you to confirm the update. Your settings and My blocks stay.</p>
  </div>`);
  const foot = h(`<div class="foot-row">
    <button class="btn" type="button" data-later>Later</button>
    <button class="btn primary" type="button" data-now>Update now</button>
  </div>`);
  const sheet = openSheet({ title: "Update available", body, foot });
  foot.querySelector("[data-later]").addEventListener("click", () => sheet.close());
  foot.querySelector("[data-now]").addEventListener("click", async () => {
    if (cur && cur.doc.dirty) {
      toast("Save or close your file first, then update.", { ms: 5000 });
      return;
    }
    sheet.close();
    const d = busy("Downloading the update…");
    try {
      await installUpdate(info, (p) => {
        if (p.total > 0) d.set(`Downloading the update… ${Math.min(99, Math.round((p.done / p.total) * 100))}%`);
      });
    } catch (e) {
      console.warn(e);
      const code = e && e.code;
      toast(code === "NO_PERMISSION" ? "To update, allow Tesseract PDF to install apps, then tap Update now again."
        : code === "BAD_FILE" ? "The download was damaged. Try again."
        : "The update couldn't be downloaded. Check your internet connection and try again.", { ms: 7000 });
    } finally {
      d.close();
    }
  });
}

$("btnInstall").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => null);
  installEvent = null;
  $("btnInstall").hidden = true;
});
window.addEventListener("appinstalled", () => {
  $("installCard").hidden = true;
  toast("Installed. Open Tesseract PDF from your home screen.");
});

// The Android app carries all its files inside it, so it has no use for the offline cache.
if ("serviceWorker" in navigator && !isAndroidApp) {
  let updateAsked = false;
  navigator.serviceWorker.register("sw.js").then((reg) => {
    const offer = (w) => {
      toast("A new version is ready.", {
        ms: 0,
        action: { label: "Update", fn: () => { updateAsked = true; w.postMessage("skipWaiting"); } }
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener("statechange", () => {
        if (w.state === "installed" && navigator.serviceWorker.controller) offer(w);
      });
    });
  }).catch((e) => console.warn("Offline support unavailable", e));
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!updateAsked) return;
    if (tabs.length) { pendingReload = true; toast(tabs.length > 1 ? "Update will finish when you close your files." : "Update will finish when you close this file."); }
    else location.reload();
  });
}

// For testing in a browser console.
window.__tpt = { get doc() { return cur && cur.doc; }, viewer, grid, markup };
