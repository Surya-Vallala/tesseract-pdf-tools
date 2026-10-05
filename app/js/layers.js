// Layers (PDF optional content), as AutoCAD writes them: read the tree, show it, toggle it.
import { libDoc, baseName } from "./doc.js";
import { openSheet, esc, h, icon, openMenu, promptDialog, confirmDialog } from "./ui.js";
import { newId } from "./doc.js";

function idOf(ref) {
  return ref.generationNumber ? `${ref.objectNumber}R${ref.generationNumber}` : `${ref.objectNumber}R`;
}

async function treeFromFile(src, groups) {
  const lib = await libDoc(src);
  const { PDFName, PDFDict, PDFArray, PDFRef, PDFString, PDFHexString } = window.PDFLib;
  const ocp = lib.catalog.lookupMaybe(PDFName.of("OCProperties"), PDFDict);
  const D = ocp && ocp.lookupMaybe(PDFName.of("D"), PDFDict);
  const order = D && D.lookupMaybe(PDFName.of("Order"), PDFArray);
  if (!order) return null;
  const ctx = lib.context;
  const seen = new Set();
  const nameOf = (id) => (groups.get(id).name || "Unnamed layer");

  function parse(items, depth) {
    const out = [];
    if (depth > 12) return out;
    for (const raw of items) {
      const val = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
      if (val instanceof PDFArray) { handleArray(val.asArray(), out, depth); continue; }
      if (raw instanceof PDFRef) {
        const id = idOf(raw);
        if (groups.has(id) && !seen.has(id)) {
          seen.add(id);
          out.push({ id, name: nameOf(id), children: [] });
        }
      }
    }
    return out;
  }
  function handleArray(arr, out, depth) {
    if (!arr.length) return;
    const first = arr[0] instanceof PDFRef ? ctx.lookup(arr[0]) : arr[0];
    if (first instanceof PDFString || first instanceof PDFHexString) {
      const kids = parse(arr.slice(1), depth + 1);
      if (kids.length) out.push({ label: first.decodeText(), children: kids });
      return;
    }
    // An array straight after a layer holds that layer's sub-layers.
    const kids = parse(arr, depth + 1);
    const prev = out[out.length - 1];
    if (prev && prev.id) prev.children.push(...kids); else out.push(...kids);
  }

  const tree = parse(order.asArray(), 0);
  const rest = [...groups.keys()].filter((id) => !seen.has(id)).map((id) => ({ id, name: nameOf(id), children: [] }));
  if (rest.length) {
    if (tree.length) tree.push({ label: "Other layers", children: rest }); else tree.push(...rest);
  }
  return tree;
}

function treeFromPdfjs(order, groups) {
  const conv = (items) => items.map((it) => {
    if (typeof it === "string") return groups.has(it) ? { id: it, name: groups.get(it).name || "Unnamed layer", children: [] } : null;
    if (it && Array.isArray(it.order)) return { label: it.name || "Other layers", children: conv(it.order) };
    return null;
  }).filter(Boolean);
  const tree = conv(order || []);
  if (tree.length === 1 && tree[0].label && !order.some((o) => typeof o === "string")) return tree[0].children;
  return tree;
}

export async function layerTree(src) {
  if (src.layerTree) return src.layerTree;
  const groups = new Map([...src.oc]);
  let tree = null;
  try { tree = await treeFromFile(src, groups); } catch (e) { /* protected or unusual file: use pdf.js order */ }
  if (!tree || !tree.length) tree = treeFromPdfjs(src.oc.getOrder(), groups);
  src.layerTree = tree;
  return tree;
}

export function layersEdited(doc) {
  return doc.layerSources.some((s) => !s.oc.hasInitialVisibility);
}

function descendants(node, out = []) {
  for (const c of node.children || []) {
    if (c.id) out.push(c.id);
    descendants(c, out);
  }
  return out;
}

export async function newDrawingLayer(doc) {
  const name = await promptDialog({ title: "New drawing layer", label: "Name", value: `Layer ${doc.layers.length + 1}`, okText: "Create" });
  if (name == null || !name.trim()) return null;
  doc.commit();
  const l = { id: newId("L"), name: name.trim(), visible: true };
  doc.layers.push(l);
  doc.activeLayer = l.id;
  return l;
}

/** Menu from the "Drawing on …" chip: pick the layer to draw on. */
export async function pickDrawingLayer(doc, anchor) {
  const items = doc.layers.map((l) => ({ label: l.name + (l.visible ? "" : " (hidden)"), value: l.id, checked: l.id === doc.activeLayer, icon: "layers" }));
  if (items.length) items.push({ divider: true });
  items.push({ label: "New layer…", value: "__new", icon: "plus" });
  const v = await openMenu(anchor, items, { align: "start" });
  if (!v) return false;
  if (v === "__new") return !!(await newDrawingLayer(doc));
  const l = doc.layer(v);
  doc.activeLayer = v;
  if (l && !l.visible) l.visible = true;
  return true;
}

/**
 * The Layers sheet: comments on/off, your drawing layers, and the layers inside the PDF.
 * hooks: { pdf(), marks(), comments() } called after changes.
 */
export async function openLayers(doc, hooks) {
  const sources = doc.layerSources;
  const trees = await Promise.all(sources.map((s) => layerTree(s)));

  const rows = [];
  const multi = sources.length > 1;
  sources.forEach((s, si) => {
    const tree = trees[si];
    if (multi) {
      const fileNode = { label: baseName(s.name), children: tree };
      rows.push({ kind: "file", src: s, depth: 0, name: fileNode.label, ids: descendants(fileNode), parents: [] });
    }
    const walk = (nodes, depth, parents) => {
      for (const n of nodes) {
        const row = n.id
          ? { kind: "layer", src: s, depth, name: n.name, id: n.id, ids: [n.id, ...descendants(n)], parents }
          : { kind: "head", src: s, depth, name: n.label, ids: descendants(n), parents };
        rows.push(row);
        walk(n.children, depth + 1, [...parents, row]);
      }
    };
    walk(tree, multi ? 1 : 0, multi ? [rows[rows.length - 1]] : []);
  });
  const totalLayers = rows.filter((r) => r.kind === "layer").length;

  const body = h(`<div class="layers-body">
    <button type="button" role="switch" class="switch-row comments-row"></button>
    <div class="sec-head"><span>Your drawing layers</span><button type="button" class="link" data-new>${icon("plus")}New layer</button></div>
    <div class="my-layers"></div>
    ${rows.length ? `<div class="sec-head"><span>Layers in this PDF</span><span><button type="button" class="link" data-all="1">All on</button><button type="button" class="link" data-all="0">All off</button></span></div>
    <div class="layer-search"><label class="search-box">${icon("search")}<input type="search" placeholder="Find a layer" aria-label="Find a layer" enterkeyhint="search"></label></div>
    <div class="sec-sub"><span class="layer-summary"></span><button class="link" type="button" data-reset hidden>Reset to file</button></div>
    <ul class="layer-list" role="list"></ul>` : ""}
  </div>`);
  const sheet = openSheet({ title: "Layers", body, tall: true, clear: true });
  sheet.body.style.padding = "0";

  const cRow = body.querySelector(".comments-row");
  const paintComments = () => {
    const n = doc.comments().length;
    cRow.setAttribute("aria-checked", doc.commentsVisible);
    cRow.innerHTML = `<span class="switch${doc.commentsVisible ? " on" : ""}"></span><span class="grow">Comments</span><small>${n ? `${n} on pages` : "Also from the PDF"}</small>`;
  };
  cRow.addEventListener("click", () => {
    doc.commentsVisible = !doc.commentsVisible;
    paintComments();
    hooks.comments && hooks.comments();
  });
  paintComments();

  const mine = body.querySelector(".my-layers");
  const paintMine = () => {
    mine.innerHTML = "";
    if (!doc.layers.length) {
      mine.appendChild(h(`<p class="sec-empty">Layers you draw on in Mark up appear here. Use them to compare design options.</p>`));
      return;
    }
    for (const l of doc.layers) {
      const row = h(`<div class="my-layer${l.visible ? "" : " off"}">
        <button type="button" role="switch" aria-checked="${l.visible}" class="my-layer-main"><span class="switch${l.visible ? " on" : ""}"></span><span class="name">${esc(l.name)}</span>${l.id === doc.activeLayer ? `<span class="tag">Drawing here</span>` : ""}</button>
        <button type="button" class="ib" aria-label="More for ${esc(l.name)}">${icon("more")}</button></div>`);
      row.querySelector(".my-layer-main").addEventListener("click", () => {
        l.visible = !l.visible;
        doc.dirty = true;
        paintMine();
        hooks.marks && hooks.marks();
      });
      const more = row.querySelector(".ib");
      more.addEventListener("click", async () => {
        const v = await openMenu(more, [
          { label: "Draw on this layer", value: "use", icon: "pen" },
          { label: "Rename", value: "rename", icon: "edit" },
          { label: "Delete layer", value: "delete", icon: "trash", danger: true }
        ]);
        if (v === "use") { doc.activeLayer = l.id; l.visible = true; }
        else if (v === "rename") {
          const name = await promptDialog({ title: "Rename layer", label: "Name", value: l.name, okText: "Rename" });
          if (name && name.trim()) { doc.commit(); l.name = name.trim(); }
        } else if (v === "delete") {
          const count = doc.pages.reduce((n, p) => n + p.items.filter((it) => it.layer === l.id).length, 0);
          const ok = await confirmDialog({ title: `Delete “${l.name}”?`, message: count ? `Its ${count} drawing${count === 1 ? "" : "s"} will be deleted too. You can undo this.` : "", okText: "Delete", danger: true });
          if (!ok) return;
          doc.commit();
          doc.layers = doc.layers.filter((x) => x.id !== l.id);
          for (const p of doc.pages) p.items = p.items.filter((it) => it.layer !== l.id);
          if (doc.activeLayer === l.id) doc.activeLayer = doc.layers.length ? doc.layers[0].id : null;
        }
        if (v) { paintMine(); hooks.marks && hooks.marks(); }
      });
      mine.appendChild(row);
    }
  };
  body.querySelector("[data-new]").addEventListener("click", async () => {
    if (await newDrawingLayer(doc)) { paintMine(); hooks.marks && hooks.marks(); }
  });
  paintMine();

  if (!rows.length) return sheet;

  const list = body.querySelector(".layer-list");
  const search = body.querySelector(".layer-search input");
  const summary = body.querySelector(".layer-summary");
  const resetBtn = body.querySelector("[data-reset]");
  let shown = rows;

  const vis = (r, id) => { const g = r.src.oc.getGroup(id); return g ? g.visible : true; };
  const stateOf = (r) => {
    let on = 0;
    for (const id of r.ids) if (vis(r, id)) on++;
    return on === 0 ? "off" : on === r.ids.length ? "on" : "mixed";
  };

  function render() {
    const q = search.value.trim().toLowerCase();
    if (q) {
      const keep = new Set();
      for (const r of rows) {
        if (r.kind === "layer" && r.name.toLowerCase().includes(q)) {
          keep.add(r);
          r.parents.forEach((p) => keep.add(p));
        }
      }
      shown = rows.filter((r) => keep.has(r));
    } else shown = rows;
    list.innerHTML = shown.length
      ? shown.map((r, i) => `<li class="layer-row ${r.kind === "layer" ? "" : r.kind === "file" ? "head file" : "head"}" style="--depth:${r.depth}" data-i="${i}" role="switch" tabindex="0">
          <span class="switch"></span><span class="name">${esc(r.name)}</span>${r.kind !== "layer" ? `<span class="count">${r.ids.length}</span>` : ""}</li>`).join("")
      : `<li class="layer-empty">No layers match “${esc(search.value.trim())}”.</li>`;
    paint();
  }

  function paint() {
    list.querySelectorAll(".layer-row").forEach((li) => {
      const r = shown[Number(li.dataset.i)];
      const st = stateOf(r);
      li.querySelector(".switch").className = "switch" + (st === "on" ? " on" : st === "mixed" ? " mixed" : "");
      li.classList.toggle("off", st === "off");
      li.setAttribute("aria-checked", st === "on" ? "true" : st === "mixed" ? "mixed" : "false");
    });
    let on = 0;
    for (const r of rows) if (r.kind === "layer" && vis(r, r.id)) on++;
    summary.textContent = `${on} of ${totalLayers} layer${totalLayers === 1 ? "" : "s"} on`;
    resetBtn.hidden = !layersEdited(doc);
  }

  function setMany(pairs, visible) {
    for (const [s, id] of pairs) s.oc.setVisibility(id, visible, false);
    doc.dirty = true;
    paint();
    hooks.pdf && hooks.pdf();
  }

  list.addEventListener("click", (e) => {
    const li = e.target.closest(".layer-row");
    if (!li) return;
    const r = shown[Number(li.dataset.i)];
    setMany(r.ids.map((id) => [r.src, id]), stateOf(r) !== "on");
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    const li = e.target.closest(".layer-row");
    if (!li) return;
    e.preventDefault();
    const r = shown[Number(li.dataset.i)];
    setMany(r.ids.map((id) => [r.src, id]), stateOf(r) !== "on");
  });
  body.querySelectorAll("[data-all]").forEach((b) => b.addEventListener("click", () => {
    const pairs = [];
    for (const r of shown) if (r.kind === "layer") pairs.push([r.src, r.id]);
    setMany(pairs, b.dataset.all === "1");
  }));
  resetBtn.addEventListener("click", async () => {
    for (const s of sources) s.oc = await s.pdf.getOptionalContentConfig();
    paint();
    hooks.pdf && hooks.pdf();
  });
  search.addEventListener("input", render);
  render();
  return sheet;
}
