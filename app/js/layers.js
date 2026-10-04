// Layers (PDF optional content), as AutoCAD writes them: read the tree, show it, toggle it.
import { libDoc, baseName } from "./doc.js";
import { openSheet, esc, h, icon } from "./ui.js";

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

export async function openLayers(doc, onChange) {
  const sources = doc.layerSources;
  const trees = await Promise.all(sources.map((s) => layerTree(s)));

  // Flatten into rows.
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
        if (n.id) {
          const row = { kind: "layer", src: s, depth, name: n.name, id: n.id, ids: [n.id, ...descendants(n)], parents };
          rows.push(row);
          walk(n.children, depth + 1, [...parents, row]);
        } else {
          const row = { kind: "head", src: s, depth, name: n.label, ids: descendants(n), parents };
          rows.push(row);
          walk(n.children, depth + 1, [...parents, row]);
        }
      }
    };
    walk(tree, multi ? 1 : 0, multi ? [rows[rows.length - 1]] : []);
  });
  const totalLayers = rows.filter((r) => r.kind === "layer").length;

  const tools = h(`<div>
    <div class="layer-tools">
      <input class="input" type="search" placeholder="Find a layer" aria-label="Find a layer" enterkeyhint="search">
      <button class="btn" type="button" data-all="1">All on</button>
      <button class="btn" type="button" data-all="0">All off</button>
    </div>
    <div class="layer-tools" style="padding-top:6px;padding-bottom:6px;justify-content:space-between">
      <span class="layer-summary"></span>
      <button class="link" type="button" data-reset hidden>Reset to file</button>
    </div>
  </div>`);
  const list = h(`<ul class="layer-list" role="list"></ul>`);
  const body = document.createElement("div");
  body.appendChild(list);
  const sheet = openSheet({ title: "Layers", body, tools, tall: true, clear: true });
  sheet.body.style.padding = "0";

  const search = tools.querySelector("input");
  const summary = tools.querySelector(".layer-summary");
  const resetBtn = tools.querySelector("[data-reset]");
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
      const sw = li.querySelector(".switch");
      sw.className = "switch" + (st === "on" ? " on" : st === "mixed" ? " mixed" : "");
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
    paint();
    onChange();
  }

  function toggleRow(r) {
    const next = stateOf(r) !== "on";
    setMany(r.ids.map((id) => [r.src, id]), next);
  }

  list.addEventListener("click", (e) => {
    const li = e.target.closest(".layer-row");
    if (li) toggleRow(shown[Number(li.dataset.i)]);
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    const li = e.target.closest(".layer-row");
    if (li) { e.preventDefault(); toggleRow(shown[Number(li.dataset.i)]); }
  });
  tools.querySelectorAll("[data-all]").forEach((b) => b.addEventListener("click", () => {
    const pairs = [];
    for (const r of shown) if (r.kind === "layer") pairs.push([r.src, r.id]);
    setMany(pairs, b.dataset.all === "1");
  }));
  resetBtn.addEventListener("click", async () => {
    for (const s of sources) s.oc = await s.pdf.getOptionalContentConfig();
    paint();
    onChange();
  });
  search.addEventListener("input", render);
  render();
  return sheet;
}
