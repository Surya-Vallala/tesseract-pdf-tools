// Tesseract PDF Tools - phone app
import { Doc, loadSource, baseName, closeSource, unlockSource, blankSource } from "./doc.js";
import { Viewer } from "./viewer.js";
import { PageGrid } from "./pages.js";
import { openCrop } from "./crop.js";
import { openLayers, pickDrawingLayer } from "./layers.js";
import { openSaveSheet } from "./save.js";
import { Markup } from "./markup.js";
import { askAuthor, openBubble, openCommentsList, editComment } from "./comments.js";
import { openTools } from "./tools.js";
import { engine } from "./engine.js";
import { pickFiles, onIncomingFiles } from "./platform.js";
import { hydrateIcons, initHistory, pushLayer, closeLayer, confirmDialog, passwordDialog, toast, busy, openMenu } from "./ui.js";

const APP_VERSION = "1.2";
const $ = (id) => document.getElementById(id);

const home = $("home");
const docScreen = $("docScreen");

hydrateIcons();
initHistory();
$("appVersion").textContent = APP_VERSION;

let cur = null; // { doc, tab, layer }
let pendingReload = false;

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

$("btnOpen").addEventListener("click", async () => {
  const files = await pickFiles({ multiple: false });
  if (files.length) openFiles(files, { combine: false });
});
$("btnCombine").addEventListener("click", async () => {
  const files = await pickFiles({ multiple: true });
  if (files.length) openFiles(files, { combine: true });
});

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

async function openFiles(files, { combine }) {
  if (cur) {
    const ok = await leaveDoc();
    if (!ok) return;
  }
  const { loaded, problems } = await loadAll(files, { many: files.length > 1 });
  if (!loaded.length) {
    if (problems.length) confirmDialog({ title: "Couldn't open", message: problems.join("\n"), okText: "OK", cancelText: "" });
    return;
  }
  const doc = new Doc();
  loaded.forEach((s) => doc.addSource(s));
  doc.name = loaded.length === 1 ? baseName(loaded[0].name) : "Combined";
  if (loaded.length === 1 && loaded[0].kind === "pdf" && loaded[0].password) doc.password = loaded[0].password;
  showDoc(doc, combine || loaded.length > 1 ? "pages" : "view");
  if (problems.length) toast(problems.join(" "), { ms: 6000 });
  if (doc.readOnly) toast("This PDF is password-protected. You can view it and turn layers on and off. To edit it, connect to the internet once and open it again.", { ms: 7000 });
  else if (doc.password) toast("This PDF has a password. Saved copies keep it. You can change it in Tools.", { ms: 5000 });
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
    for (const s of loaded) {
      const added = doc.addSource(s, at);
      at += added.length;
      count += added.length;
    }
    if (doc.sources.size > 1 && doc.name !== "Combined") doc.name = "Combined";
    doc.changed({ added: true });
    toast(`Added ${count} page${count === 1 ? "" : "s"}`);
  }
  if (problems.length) toast(problems.join(" "), { ms: 6000 });
}

/* ---------- document screen ---------- */

function showDoc(doc, tab) {
  cur = { doc, tab: null, layer: null };
  home.hidden = true;
  docScreen.hidden = false;
  docScreen.classList.remove("immersive");
  $("docTitle").textContent = doc.name + ".pdf";
  viewer.setDoc(doc);
  grid.setDoc(doc);
  doc.on("pages", () => {
    viewer.refresh();
    grid.refresh();
    markup.drawSelection();
    if (cur && cur.tab === "markup") markup.renderOptions();
    updateDocUi();
  });
  cur.layer = pushLayer({
    canClose: () => {
      if (cur && cur.tab === "markup") {
        setTimeout(() => setTab("view"));
        return false;
      }
      if (doc.dirty && doc.pages.length) {
        setTimeout(() => leaveDoc().then((ok) => ok && cur && cur.doc === doc && closeLayer(cur.layer)));
        return false;
      }
      return true;
    },
    onClose: () => teardown(doc)
  });
  setTab(tab);
  updateDocUi();
}

async function leaveDoc() {
  if (!cur) return true;
  const doc = cur.doc;
  if (doc.dirty && doc.pages.length) {
    const ok = await confirmDialog({
      title: "Discard changes?",
      message: "Your changes to this PDF haven't been saved.",
      okText: "Discard",
      cancelText: "Keep editing",
      danger: true
    });
    if (!ok) return false;
    doc.dirty = false;
  }
  if (cur && cur.doc === doc) {
    if (cur.tab === "markup") { markup.exit(); cur.tab = "view"; }
    closeLayer(cur.layer);
  }
  return true;
}

function teardown(doc) {
  if (cur && cur.tab === "markup") markup.exit();
  viewer.hide();
  viewer.clear();
  grid.clear();
  for (const s of doc.sources.values()) closeSource(s);
  cur = null;
  docScreen.hidden = true;
  docScreen.classList.remove("mode-markup", "tab-pages", "tab-view");
  home.hidden = false;
  if (pendingReload) location.reload();
}

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
      marks: () => { marksChanged(); markup.updateChip(); },
      comments: () => { viewer.layersChanged(); grid.layersChanged(); marksChanged(); }
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
  if (await pickDrawingLayer(cur.doc, e.currentTarget)) { markup.updateChip(); marksChanged(); }
});
$("commentsChip").addEventListener("click", () => {
  if (!cur) return;
  openCommentsList(cur.doc, {
    onGo: (page) => { setTab("view"); viewer.scrollToPage(cur.doc.pages.indexOf(page)); },
    onChange: marksChanged,
    onToggle: () => { viewer.layersChanged(); grid.layersChanged(); marksChanged(); }
  });
});

$("btnSelAll").addEventListener("click", () => grid.setAll(grid.selection.size === 0));
$("btnAddFiles").addEventListener("click", async () => {
  const files = await pickFiles({ multiple: true });
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
        { label: "Duplicate", value: "dup", icon: "copy" },
        { label: "Insert blank page after", value: "blank", icon: "blank" },
        { label: "Move to start", value: "start", icon: "tostart" },
        { label: "Move to end", value: "end", icon: "toend" }
      ], { above: true });
      if (!v) return;
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
  if (cur && cur.doc.dirty) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------- files arriving from other apps ---------- */

onIncomingFiles((files, info) => {
  if (info && info.error) { toast("The shared file couldn't be read. Try again."); return; }
  if (!files.length) { if (info && info.shared) toast("Nothing arrived. Try sharing the file again."); return; }
  openFiles(files, { combine: files.length > 1 });
});

/* ---------- install and updates ---------- */

const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
$("shareTip").hidden = !standalone;
$("installCard").hidden = standalone;
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("btnInstall").hidden = false;
  $("installManual").hidden = true;
});
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

if ("serviceWorker" in navigator) {
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
    if (cur && cur.doc.dirty) { pendingReload = true; toast("Update will finish when you close this file."); }
    else location.reload();
  });
}

// For testing in a browser console.
window.__tpt = { get doc() { return cur && cur.doc; }, viewer, grid, markup };
