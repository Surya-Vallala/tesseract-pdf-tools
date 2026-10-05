// Architecture blocks: the library picker and the drawing-scale sheet.
import { BLOCK_FAMILIES, BLOCK_CATEGORIES, blockTiles, blockParts, sizeText, sizeIn, parseSizeText } from "./blocks.js";
import { h, esc, icon, openSheet, segmented, promptDialog } from "./ui.js";
import { settings } from "./platform.js";

// Extra words people search with.
const KEYWORDS = {
  door: "door entry swing", door2: "door double french", "sliding-door": "door slider", window: "window glazing", "sliding-window": "window slider",
  ventilator: "ventilator vent toilet window", bed: "bed cot mattress", bedside: "bedside side table nightstand", study: "study desk table chair work",
  dresser: "dressing table mirror vanity", sofa: "sofa couch seater settee", lsofa: "sofa couch corner sectional", coffee: "coffee centre center table",
  sidetable: "side table round", tv: "tv television unit console", dining: "dining table chairs", "round-dining": "dining round table",
  hob: "hob stove cooktop gas burner", chimney: "chimney hood exhaust", sink: "sink kitchen wash", fridge: "fridge refrigerator ref",
  dishwasher: "dishwasher dw", washer: "washing machine laundry utility", ewc: "wc toilet commode western ewc", wallwc: "wc toilet wall hung",
  iwc: "wc toilet indian squat orissa iwc", basin: "washbasin basin wash hand sink", counterbasin: "basin counter vanity wash",
  shower: "shower bath", bathtub: "bathtub tub bath", wardrobe: "wardrobe cupboard closet storage", loft: "loft storage overhead",
  shoerack: "shoe rack storage", bookshelf: "bookshelf books shelf", pooja: "pooja puja mandir prayer", stair: "stair staircase steps",
  dogleg: "stair staircase dog legged steps", car: "car parking vehicle suv", bike: "two wheeler bike scooter motorcycle parking",
  tree: "tree landscape", shrub: "shrub plant bush landscape", planter: "planter pot plant"
};

const CAT_SHORT = { doors: "Doors and windows", bedroom: "Bedroom", living: "Living", dining: "Dining", kitchen: "Kitchen", bath: "Bathroom", storage: "Storage", stairs: "Stairs", outdoor: "Outdoor" };

export const STANDARD_SCALES = [20, 25, 50, 75, 100, 200, 500];

export const mmPerPoint = 25.4 / 72;

/** Base units per real millimetre for a paper scale 1:n (pages measured in points). */
export function kForRatio(n) {
  return 72 / (25.4 * n);
}
export function ratioForK(k) {
  const n = 72 / (25.4 * k);
  for (const s of STANDARD_SCALES) if (Math.abs(n - s) / s < 0.015) return s;
  return Math.round(n);
}

/** "mm" or "ftin", remembered on this phone. */
export function getUnits() {
  return settings.get("units", "mm") === "ftin" ? "ftin" : "mm";
}
export function setUnits(u) {
  settings.set("units", u === "ftin" ? "ftin" : "mm");
}

export function familyOf(id) {
  return BLOCK_FAMILIES.find((f) => f.id === id) || null;
}

export function tileSVG(family, w, d, p, bw = 88, bh = 56) {
  const k = Math.max(w / (bw - 6), d / (bh - 6), 20);
  const sw = w / k, sh = d / k;
  let s = "";
  for (const part of blockParts(family, w, d, p)) {
    if (part.text) {
      s += `<text x="${part.x.toFixed(0)}" y="${part.y.toFixed(0)}" font-size="${part.size.toFixed(0)}" text-anchor="middle" dominant-baseline="central" fill="currentColor" font-family="Helvetica, Arial, sans-serif">${esc(part.text)}</text>`;
      continue;
    }
    const dd = part.cmds.map((c) => c[0] + c.slice(1).map((n) => n.toFixed(1)).join(" ")).join("");
    s += `<path d="${dd}" fill="${part.fill ? "var(--surface, #fff)" : "none"}" stroke="currentColor" stroke-width="1.1" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"${part.dash ? ' stroke-dasharray="4 3"' : ""}/>`;
  }
  return `<svg width="${bw}" height="${bh}" viewBox="0 0 ${bw} ${bh}" aria-hidden="true"><g transform="translate(${((bw - sw) / 2).toFixed(1)} ${((bh - sh) / 2).toFixed(1)}) scale(${(1 / k).toFixed(5)})">${s}</g></svg>`;
}

function recent() {
  const r = settings.get("recent-blocks", []);
  return Array.isArray(r) ? r : [];
}
export function rememberBlock(tile) {
  const r = recent().filter((x) => !(x.family === tile.family && x.name === tile.name));
  r.unshift({ family: tile.family, name: tile.name });
  settings.set("recent-blocks", r.slice(0, 9));
}

/**
 * The "Architecture" pane of the Shapes sheet.
 * onPick(tile) is called with { family, name, w, d, p }.
 */
export function blockPicker({ onPick, scaleNote, onChangeScale }) {
  let units = getUnits();
  let all = blockTiles(units);
  let rec = recent().map((r) => all.find((t) => t.family === r.family && t.name === r.name)).filter(Boolean);
  let cat = settings.get("blocks-cat", rec.length ? "recent" : "bedroom");
  if (cat === "recent" && !rec.length) cat = "bedroom";
  let query = "";
  const el = h(`<div class="blocks-pane">
    <label class="block-search">${icon("search")}<input type="search" placeholder="Search blocks, like queen bed or WC" aria-label="Search blocks" enterkeyhint="search"></label>
    <div class="block-cats" role="tablist" aria-label="Block categories"></div>
    <div class="block-grid"></div>
    <p class="block-empty" hidden>No blocks match that. Try another word.</p>
  </div>`);
  const cats = el.querySelector(".block-cats");
  const grid = el.querySelector(".block-grid");
  const empty = el.querySelector(".block-empty");
  const input = el.querySelector("input");
  const list = [];
  if (rec.length) list.push({ id: "recent", name: "Recent" });
  for (const c of BLOCK_CATEGORIES) list.push({ id: c.id, name: CAT_SHORT[c.id] || c.name });
  for (const c of list) {
    const b = h(`<button type="button" role="tab" class="block-cat" data-cat="${c.id}">${c.id === "recent" ? icon("clock") : ""}<span>${esc(c.name)}</span></button>`);
    b.addEventListener("click", () => { cat = c.id; settings.set("blocks-cat", cat); query = ""; input.value = ""; paint(); b.scrollIntoView({ inline: "nearest", block: "nearest" }); });
    cats.appendChild(b);
  }
  input.addEventListener("input", () => { query = input.value.trim().toLowerCase(); paint(); });
  function paint() {
    cats.querySelectorAll(".block-cat").forEach((b) => {
      const on = !query && b.dataset.cat === cat;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    let tiles;
    if (query) {
      const words = query.split(/\s+/);
      tiles = all.filter((t) => {
        const hay = `${t.name} ${KEYWORDS[t.family] || ""} ${CAT_SHORT[t.cat] || ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    } else tiles = cat === "recent" ? rec : all.filter((t) => t.cat === cat);
    grid.textContent = "";
    for (const t of tiles) {
      const b = h(`<button type="button" class="block-tile">${tileSVG(t.family, t.w, t.d, t.p)}<b>${esc(t.name)}</b><small>${sizeText(t.w, t.d, units)}</small></button>`);
      b.addEventListener("click", () => onPick(t));
      grid.appendChild(b);
    }
    empty.hidden = tiles.length > 0;
  }
  paint();
  const foot = h(`<div class="block-foot">${icon("ruler")}<span class="grow">${scaleNote} <button type="button" class="link">Change</button></span></div>`);
  foot.querySelector(".link").addEventListener("click", onChangeScale);
  const useg = segmented([{ value: "mm", label: "mm" }, { value: "ftin", label: "ft-in" }], units, (v) => {
    units = v;
    setUnits(v);
    all = blockTiles(units);
    rec = recent().map((r) => all.find((t) => t.family === r.family && t.name === r.name)).filter(Boolean);
    paint();
  }, { small: true, label: "Units" });
  foot.appendChild(useg);
  setTimeout(() => { const on = cats.querySelector(".block-cat.on"); if (on) on.scrollIntoView({ inline: "nearest", block: "nearest" }); }, 0);
  return { el, foot };
}

/** Looks for "1:100" style scales in a PDF page's text. Returns the most common, or null. */
export async function findScale(doc, p) {
  const s = doc.src(p);
  if (s.kind !== "pdf") return null;
  try {
    const page = await s.pdf.getPage(p.index + 1);
    const tc = await page.getTextContent();
    const text = tc.items.map((it) => it.str || "").join(" ");
    const counts = new Map();
    for (const m of text.matchAll(/(?:^|[^\d.])1\s*[:：]\s*(\d{1,4})(?![\d.])/g)) {
      const n = Number(m[1]);
      if (n >= 5 && n <= 2000) counts.set(n, (counts.get(n) || 0) + 1);
    }
    let best = null, bc = 0;
    for (const [n, c] of counts) if (c > bc) { best = n; bc = c; }
    return best;
  } catch (e) {
    return null;
  }
}

/**
 * Asks for the drawing scale. Resolves { k } for a paper scale, { measure: true } to measure
 * on the page instead, or null if cancelled.
 */
export function openScaleSheet({ photo, suggested, current, firstTime }) {
  return new Promise((resolve) => {
    let result = null;
    let pick = current || suggested || 100;
    const body = h(`<div class="scale-body">
      <p class="note" style="margin-top:0">${photo
        ? "This page is a photo or scan, so measure something on it that you know the length of."
        : firstTime ? "Blocks are drawn to real size, so they need this drawing's scale. You set it once for this file." : "Blocks on this page follow the new scale."}</p>
      <div data-found></div>
      <div data-scales></div>
      <button type="button" class="radio-card measure-card">${icon("ruler")}<span><b>Measure something you know</b><small>For photos, scans or drawings not printed to scale</small></span>${icon("chev")}</button>
    </div>`);
    const foot = h(`<div class="foot-row"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="button" data-ok></button></div>`);
    const ok = foot.querySelector("[data-ok]");
    if (suggested && !photo) {
      body.querySelector("[data-found]").appendChild(h(`<div class="found-card">${icon("check")}<span><b>Found 1:${suggested} on this sheet</b><small>From the text on the page</small></span></div>`));
    }
    const box = body.querySelector("[data-scales]");
    const paintOk = () => { ok.textContent = `Use 1:${pick}`; };
    if (!photo) {
      box.appendChild(h(`<div class="group-label">Scale on paper</div>`));
      const grid = h(`<div class="scale-grid" role="radiogroup" aria-label="Scale"></div>`);
      const values = [...STANDARD_SCALES];
      if (!values.includes(pick)) values.push(pick);
      const paintChips = () => grid.querySelectorAll("[data-n]").forEach((b) => {
        const on = Number(b.dataset.n) === pick;
        b.classList.toggle("on", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
      });
      for (const n of values) {
        const b = h(`<button type="button" role="radio" class="scale-chip" data-n="${n}">1:${n}</button>`);
        b.addEventListener("click", () => { pick = n; paintChips(); paintOk(); });
        grid.appendChild(b);
      }
      const other = h(`<button type="button" class="scale-chip">Other</button>`);
      other.addEventListener("click", async () => {
        const v = await promptDialog({ title: "Other scale", label: "1 :", value: String(pick), okText: "Use", validate: (x) => (/^\s*\d{1,5}\s*$/.test(x) && Number(x) >= 1 ? null : "Type a number, like 30.") });
        if (v == null) return;
        pick = Number(v);
        if (!grid.querySelector(`[data-n="${pick}"]`)) {
          const b = h(`<button type="button" role="radio" class="scale-chip" data-n="${pick}">1:${pick}</button>`);
          b.addEventListener("click", () => { pick = Number(b.dataset.n); paintChips(); paintOk(); });
          grid.insertBefore(b, other);
        }
        paintChips(); paintOk();
      });
      grid.appendChild(other);
      box.appendChild(grid);
      paintChips();
      paintOk();
    } else {
      ok.remove();
    }
    const sheet = openSheet({ title: "Drawing scale", body, foot, onClose: () => resolve(result) });
    body.querySelector(".measure-card").addEventListener("click", () => { result = { measure: true }; sheet.close(); });
    foot.querySelector("[data-cancel]").addEventListener("click", () => sheet.close());
    if (ok.isConnected) ok.addEventListener("click", () => { result = { k: kForRatio(pick), ratio: pick }; sheet.close(); });
  });
}

/** Menu items for a block's Size button. */
export function sizeChoices(it, units = getUnits()) {
  const f = familyOf(it.family);
  if (!f) return [];
  const named = f.sizes.filter((s) => s.name).length > 1;
  return f.sizes.map((s, i) => {
    const [w, d] = sizeIn(f, s, units);
    return {
      i, w, d,
      label: named && s.name ? `${s.name.replace(/ (bed|sofa|dining)$/i, "")} · ${sizeText(w, d, units)}` : sizeText(w, d, units),
      checked: Math.abs(w - it.bw) < 2 && Math.abs(d - it.bd) < 2 && JSON.stringify(s.p || null) === JSON.stringify(it.p || null),
      size: s
    };
  });
}

export { parseSizeText };

export { segmented, BLOCK_FAMILIES };
