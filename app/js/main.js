// Tesseract PDF Tools - phone app
import { Doc, loadSource, baseName, closeSource } from "./doc.js";
import { Viewer } from "./viewer.js";
import { PageGrid } from "./pages.js";
import { openCrop } from "./crop.js";
import { openLayers } from "./layers.js";
import { openSaveSheet } from "./save.js";
import { hydrateIcons, initHistory, pushLayer, closeLayer, confirmDialog, passwordDialog, toast, busy } from "./ui.js";

const APP_VERSION = "1.0";
const $ = (id) => document.getElementById(id);

const home = $("home");
const docScreen = $("docScreen");
const pickOne = $("pickOne");
const pickMany = $("pickMany");

hydrateIcons();
initHistory();
$("appVersion").textContent = APP_VERSION;

const viewer = new Viewer($("viewer"), $("vwrap"), $("pageBadge"), {
  onTap: () => { if (cur && cur.tab === "view") docScreen.classList.toggle("immersive"); },
  onPage: (i) => { if (cur && cur.tab === "view") setMeta(`Page ${i + 1} of ${cur.doc.pages.length}`); }
});
const grid = new PageGrid($("pagesView"), $("grid"), {
  onSelection: (n) => updateSelectionUi(n)
});

let cur = null; // { doc, tab, layer }
let pendingReload = false;

/* ---------- opening files ---------- */

let pickerMode = "open";
$("btnOpen").addEventListener("click", () => { pickerMode = "open"; pickOne.value = ""; pickOne.click(); });
$("btnCombine").addEventListener("click", () => { pickerMode = "combine"; pickMany.value = ""; pickMany.click(); });
pickOne.addEventListener("change", () => { if (pickOne.files.length) openFiles([...pickOne.files], { combine: false }); });
pickMany.addEventListener("change", () => {
  if (!pickMany.files.length) return;
  if (pickerMode === "add") addFiles([...pickMany.files]);
  else openFiles([...pickMany.files], { combine: true });
});

async function loadAll(files, { allowProtected }) {
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
      if (src.kind === "pdf" && src.encrypted && !allowProtected) {
        problems.push(`“${src.name}” is password-protected, so it can't be combined yet.`);
        closeSource(src);
        continue;
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
  const { loaded, problems } = await loadAll(files, { allowProtected: files.length === 1 });
  if (!loaded.length) {
    if (problems.length) confirmDialog({ title: "Couldn't open", message: problems.join("\n"), okText: "OK", cancelText: "" });
    return;
  }
  const doc = new Doc();
  loaded.forEach((s) => doc.addSource(s));
  doc.name = loaded.length === 1 ? baseName(loaded[0].name) : "Combined";
  showDoc(doc, combine || loaded.length > 1 ? "pages" : "view");
  if (problems.length) toast(problems.join(" "), { ms: 6000 });
  if (doc.readOnly) toast("Password-protected PDF: you can view it and turn layers on and off.", { ms: 5000 });
}

async function addFiles(files) {
  if (!cur) return;
  const doc = cur.doc;
  const { loaded, problems } = await loadAll(files, { allowProtected: false });
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
    if (doc.name !== "Combined" && doc.sources.size > 1 && !doc.renamed) doc.name = "Combined";
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
  $("btnAdd").disabled = doc.readOnly;
  viewer.setDoc(doc);
  grid.setDoc(doc);
  doc.on("pages", () => {
    viewer.refresh();
    grid.refresh();
    updateDocUi();
  });
  cur.layer = pushLayer({
    canClose: () => {
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
    const layer = cur.layer;
    await new Promise((resolve) => {
      const done = () => { window.removeEventListener("popstate", done); setTimeout(resolve, 0); };
      window.addEventListener("popstate", done);
      closeLayer(layer);
    });
  }
  return true;
}

function teardown(doc) {
  viewer.hide();
  viewer.clear();
  grid.clear();
  for (const s of doc.sources.values()) closeSource(s);
  cur = null;
  docScreen.hidden = true;
  home.hidden = false;
  if (pendingReload) location.reload();
}

function setTab(tab) {
  if (!cur) return;
  if (tab === "pages" && cur.doc.readOnly) {
    toast("Password-protected PDFs can't be edited yet.");
    return;
  }
  cur.tab = tab;
  document.querySelectorAll("#tabbar .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  const inView = tab === "view";
  $("viewer").hidden = !inView;
  $("pagesView").hidden = inView;
  if (!inView) docScreen.classList.remove("immersive");
  if (inView) {
    const sel = grid.selectedPages();
    viewer.show();
    if (sel.length) viewer.scrollToPage(cur.doc.pages.indexOf(sel[0]));
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
  $("btnUndo").disabled = !doc.history.length;
  $("btnSave").disabled = !n;
  $("emptyDoc").hidden = n > 0;
  document.querySelector('#tabbar [data-tab="layers"]').hidden = !doc.layerSources.length;
  if (cur.tab === "view") setMeta(n ? `Page ${viewer.currentIndex() + 1} of ${n}` : "No pages");
  else setMeta(`${n} page${n === 1 ? "" : "s"}`);
  updateSelectionUi(grid.selection.size);
}

function updateSelectionUi(count) {
  if (!cur) return;
  const inPages = cur.tab === "pages";
  $("selbar").hidden = !(inPages && count > 0);
  $("tabbar").hidden = inPages && count > 0;
  $("pagesInfo").textContent = count ? `${count} selected` : "Tap pages to select them. Press and hold to drag.";
  $("btnSelAll").textContent = count ? "Clear" : "Select all";
}

$("tabbar").addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b || !cur) return;
  if (b.dataset.tab === "layers") {
    if (cur.tab !== "view") setTab("view");
    openLayers(cur.doc, () => { viewer.layersChanged(); grid.layersChanged(); });
    return;
  }
  setTab(b.dataset.tab);
});

$("btnSelAll").addEventListener("click", () => grid.setAll(grid.selection.size === 0));

$("selbar").addEventListener("click", (e) => {
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
  }
});

function undo() {
  if (cur && cur.doc.undo()) toast("Undone", { ms: 1500 });
}

$("btnUndo").addEventListener("click", undo);
$("btnAdd").addEventListener("click", () => { pickerMode = "add"; pickMany.value = ""; pickMany.click(); });
$("btnSave").addEventListener("click", () => {
  if (!cur || !cur.doc.pages.length) return;
  openSaveSheet(cur.doc, { onSaved: () => updateDocUi() });
});
$("btnBack").addEventListener("click", () => { leaveDoc(); });
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && cur && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault();
    undo();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (cur && cur.doc.dirty) { e.preventDefault(); e.returnValue = ""; }
});

/* ---------- files arriving from other apps ---------- */

async function takeSharedFiles() {
  const params = new URLSearchParams(location.search);
  if (!params.has("share")) return;
  history.replaceState({ depth: 0 }, "", location.pathname);
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
    if (files.length) openFiles(files, { combine: files.length > 1 });
    else toast("Nothing arrived. Try sharing the file again.");
  } catch (e) {
    console.error(e);
    toast("The shared file couldn't be read. Try again.");
  }
}

if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    openFiles(files, { combine: files.length > 1 });
  });
}

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

takeSharedFiles();
