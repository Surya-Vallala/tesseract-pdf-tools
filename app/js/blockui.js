// Architecture blocks: the library picker and the drawing-scale sheet.
import { BLOCK_FAMILIES, BLOCK_CATEGORIES, blockTiles, blockParts, sizeText, sizeIn, parseSizeText } from "./blocks.js";
import { h, esc, icon, openSheet, segmented, promptDialog, choiceDialog, confirmDialog, openMenu, toast, busy } from "./ui.js";
import { settings } from "./platform.js";
import { aiKey, setAiKey, drawBlock } from "./ai.js";

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
  const r = recent().filter((x) => !(x.family === tile.family && x.name === tile.name && (x.mine || null) === (tile.mine || null)));
  r.unshift({ family: tile.family, name: tile.name, ...(tile.mine ? { mine: tile.mine } : {}) });
  settings.set("recent-blocks", r.slice(0, 9));
}

/**
 * The "Architecture" pane of the Shapes sheet.
 * onPick(tile) is called with { family, name, w, d, p }.
 */
/* ---------- My blocks: made with AI or from your own drawing, kept on this phone ---------- */

export function myBlocks() {
  const r = settings.get("my-blocks", []);
  return Array.isArray(r) ? r : [];
}
function storeMyBlocks(list) {
  settings.set("my-blocks", list);
  return settings.get("my-blocks", []).length === list.length;
}
/** Saves a block to My blocks. Returns it, or null if the phone's storage is full. */
export function addMyBlock({ name, w, d, parts, src, prompt }) {
  const b = { id: "mb" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: (name || "My block").slice(0, 40), w: Math.round(w), d: Math.round(d), parts, src: src || "", prompt: prompt || "" };
  return storeMyBlocks([b, ...myBlocks()]) ? b : null;
}
export function myTile(b) {
  return { family: "custom", cat: "mine", name: b.name, w: b.w, d: b.d, p: { w0: b.w, d0: b.d, parts: b.parts }, mine: b.id };
}

/**
 * The "Architecture" pane of the Shapes sheet.
 * onPick(tile) is called with { family, name, w, d, p }; onAI(description) and onFromDrawing()
 * start a new custom block.
 */
export function blockPicker({ onPick, scaleNote, onChangeScale, onAI, onFromDrawing }) {
  let units = getUnits();
  let all = blockTiles(units);
  let mine = myBlocks().map(myTile);
  const findRecent = () => recent().map((r) => (r.mine ? mine.find((t) => t.mine === r.mine) : all.find((t) => t.family === r.family && t.name === r.name))).filter(Boolean);
  let rec = findRecent();
  let cat = settings.get("blocks-cat", rec.length ? "recent" : "bedroom");
  if (cat === "recent" && !rec.length) cat = "bedroom";
  let query = "";
  const el = h(`<div class="blocks-pane">
    <label class="block-search">${icon("search")}<input type="search" placeholder="Search, or describe a new block" aria-label="Search blocks" enterkeyhint="search"></label>
    <div class="block-cats" role="tablist" aria-label="Block categories"></div>
    <div class="block-grid"></div>
    <p class="block-empty" hidden></p>
  </div>`);
  const cats = el.querySelector(".block-cats");
  const grid = el.querySelector(".block-grid");
  const empty = el.querySelector(".block-empty");
  const input = el.querySelector("input");
  const list = [];
  if (rec.length) list.push({ id: "recent", name: "Recent", ic: "clock" });
  list.push({ id: "mine", name: "My blocks", ic: "star" });
  for (const c of BLOCK_CATEGORIES) list.push({ id: c.id, name: CAT_SHORT[c.id] || c.name });
  for (const c of list) {
    const b = h(`<button type="button" role="tab" class="block-cat" data-cat="${c.id}">${c.ic ? icon(c.ic) : ""}<span>${esc(c.name)}</span></button>`);
    b.addEventListener("click", () => { cat = c.id; settings.set("blocks-cat", cat); query = ""; input.value = ""; paint(); b.scrollIntoView({ inline: "nearest", block: "nearest" }); });
    cats.appendChild(b);
  }
  input.addEventListener("input", () => { query = input.value.trim().toLowerCase(); paint(); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
  const actionTile = (ic, title, sub, fn) => {
    const b = h(`<button type="button" class="block-tile action"><span class="act-ic">${icon(ic)}</span><b>${esc(title)}</b><small>${esc(sub)}</small></button>`);
    b.addEventListener("click", fn);
    grid.appendChild(b);
  };
  function addTile(t) {
    const b = h(`<button type="button" class="block-tile">${tileSVG(t.family, t.w, t.d, t.p)}<b>${esc(t.name)}</b><small>${sizeText(t.w, t.d, units)}</small></button>`);
    b.addEventListener("click", () => onPick(t));
    if (t.mine) {
      const more = h(`<span class="tile-more" role="button" tabindex="0" aria-label="Rename or delete">${icon("more")}</span>`);
      more.addEventListener("click", async (e) => {
        e.stopPropagation();
        const v = await openMenu(more, [{ label: "Rename", value: "rename", icon: "edit" }, { label: "Delete", value: "delete", icon: "trash", danger: true }]);
        if (v === "rename") {
          const nm = await promptDialog({ title: "Rename block", value: t.name, okText: "Rename" });
          if (nm && nm.trim()) {
            storeMyBlocks(myBlocks().map((x) => (x.id === t.mine ? { ...x, name: nm.trim().slice(0, 40) } : x)));
            refresh();
          }
        } else if (v === "delete") {
          if (await confirmDialog({ title: `Delete “${t.name}”?`, message: "Blocks already on your drawings stay as they are.", okText: "Delete", danger: true })) {
            storeMyBlocks(myBlocks().filter((x) => x.id !== t.mine));
            refresh();
          }
        }
      });
      b.appendChild(more);
    }
    grid.appendChild(b);
  }
  function refresh() {
    mine = myBlocks().map(myTile);
    rec = findRecent();
    paint();
  }
  function paint() {
    cats.querySelectorAll(".block-cat").forEach((b) => {
      const on = !query && b.dataset.cat === cat;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    grid.textContent = "";
    empty.hidden = true;
    if (query) {
      const words = query.split(/\s+/);
      const hit = (t) => {
        const hay = `${t.name} ${KEYWORDS[t.family] || ""} ${CAT_SHORT[t.cat] || ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      };
      const tiles = [...mine.filter(hit), ...all.filter(hit)];
      tiles.forEach(addTile);
      const raw = input.value.trim();
      if (!tiles.length) { empty.textContent = `Nothing called “${raw}” in the library.`; empty.hidden = false; }
      if (onAI) actionTile("sparkle", "Create with AI", `“${raw.slice(0, 40)}”`, () => onAI(raw));
      return;
    }
    if (cat === "mine") {
      if (onAI) actionTile("sparkle", "Create with AI", "Describe it, Claude draws it", async () => {
        const d = await promptDialog({ title: "Create with AI", message: "Describe the block, like “sliding folding door, 4 panels, 2400 wide”.", placeholder: "Sliding folding door", okText: "Next" });
        if (d && d.trim()) onAI(d.trim());
      });
      if (onFromDrawing) actionTile("select", "From my drawing", "Box marks you've drawn", onFromDrawing);
      mine.forEach(addTile);
      if (!mine.length) { empty.textContent = "Blocks you make are kept here, on this phone, and work offline."; empty.hidden = false; }
      return;
    }
    (cat === "recent" ? rec : all.filter((t) => t.cat === cat)).forEach(addTile);
  }
  paint();
  const foot = h(`<div class="block-foot">${icon("ruler")}<span class="grow">${scaleNote} <button type="button" class="link">Change</button></span></div>`);
  foot.querySelector(".link").addEventListener("click", onChangeScale);
  const useg = segmented([{ value: "mm", label: "mm" }, { value: "ftin", label: "ft-in" }], units, (v) => {
    units = v;
    setUnits(v);
    all = blockTiles(units);
    rec = findRecent();
    paint();
  }, { small: true, label: "Units" });
  foot.appendChild(useg);
  setTimeout(() => { const on = cats.querySelector(".block-cat.on"); if (on) on.scrollIntoView({ inline: "nearest", block: "nearest" }); }, 0);
  return { el, foot };
}

/* ---------- Creating a block with AI ---------- */

/** Asks for the Claude API key. Resolves true when one is saved. */
export function openAiSetup() {
  return new Promise((resolve) => {
    let saved = false;
    const has = !!aiKey();
    const body = h(`<div class="ai-setup">
      <p class="note" style="margin-top:0">Claude can draw blocks that aren't in the library. It uses your own Claude API key, which is kept only on this phone.</p>
      <ol class="ai-steps">
        <li>Open <b>platform.claude.com</b> on a computer or phone and sign in.</li>
        <li>Add a little credit and set a <b>monthly spend limit</b> under Billing. Each block costs a small amount, billed to that account (separate from a Claude subscription).</li>
        <li>Under <b>API keys</b>, create a key and paste it below.</li>
      </ol>
      <label class="field"><span>Claude API key</span><span class="pw-wrap"><input class="input" type="password" name="k" autocomplete="off" spellcheck="false" placeholder="sk-ant-…"><button type="button" class="ib" aria-label="Show key">${icon("eye")}</button></span></label>
      <p class="note">Only the words you type to describe a block are sent to Claude, and only after you say yes. Your PDFs and drawings never leave this phone.</p>
      <p class="form-error" hidden></p>
    </div>`);
    const foot = h(`<div class="foot-row">${has ? `<button class="btn danger-outline" type="button" data-remove>Remove key</button>` : `<button class="btn" type="button" data-cancel>Cancel</button>`}<button class="btn primary" type="button" data-ok>Save key</button></div>`);
    const sheet = openSheet({ title: "AI shapes", body, foot, onClose: () => resolve(saved) });
    const inp = body.querySelector("input");
    const err = body.querySelector(".form-error");
    if (has) inp.placeholder = "A key is saved. Paste a new one to replace it.";
    body.querySelector(".pw-wrap .ib").addEventListener("click", (e) => {
      inp.type = inp.type === "password" ? "text" : "password";
      e.currentTarget.innerHTML = icon(inp.type === "password" ? "eye" : "eyeoff");
    });
    foot.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.hasAttribute("data-cancel")) { sheet.close(); return; }
      if (b.hasAttribute("data-remove")) { setAiKey(""); toast("AI key removed from this phone"); sheet.close(); return; }
      const k = inp.value.trim();
      if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(k)) { err.textContent = "That doesn't look like a Claude API key. It starts with sk-ant-."; err.hidden = false; return; }
      setAiKey(k);
      saved = true;
      sheet.close();
    });
    setTimeout(() => inp.focus(), 80);
  });
}

function previewSVG(r, box = { w: 300, h: 180 }) {
  const k = Math.max(r.w / box.w, r.d / box.h);
  const sw = r.w / k, sh = r.d / k;
  let out = "";
  for (const part of blockParts("custom", r.w, r.d, { w0: r.w, d0: r.d, parts: r.parts })) {
    if (part.text) { out += `<text x="${part.x.toFixed(0)}" y="${part.y.toFixed(0)}" font-size="${part.size.toFixed(0)}" text-anchor="middle" dominant-baseline="central" fill="currentColor" font-family="Helvetica, Arial, sans-serif">${esc(part.text)}</text>`; continue; }
    const dd = part.cmds.map((c) => c[0] + c.slice(1).map((n) => n.toFixed(1)).join(" ")).join("");
    out += `<path d="${dd}" fill="${part.fill ? "var(--surface, #fff)" : "none"}" stroke="currentColor" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"${part.dash ? ' stroke-dasharray="5 4"' : ""}/>`;
  }
  return `<svg width="${box.w}" height="${box.h}" viewBox="0 0 ${box.w} ${box.h}" aria-hidden="true"><g transform="translate(${((box.w - sw) / 2).toFixed(1)} ${((box.h - sh) / 2).toFixed(1)}) scale(${(1 / k).toFixed(5)})">${out}</g></svg>`;
}

/**
 * The whole "Create with AI" flow: key (first time), permission, drawing, preview.
 * onUse(tile) places the block once it's saved to My blocks.
 */
export async function createWithAI(description, { onUse }) {
  if (!aiKey() && !(await openAiSetup())) return;
  const ok = await choiceDialog({
    title: "Create with AI?",
    message: `This sends only the words “${description}” to Claude, by Anthropic, over the internet. Your drawings and files stay on this phone.`,
    choices: [{ label: "Not now", value: null }, { label: "Create", value: "go", kind: "primary" }]
  });
  if (!ok) return;
  const units = getUnits();
  const b = busy(`Claude is drawing “${description.slice(0, 40)}”…`);
  let r;
  try {
    r = await drawBlock(description, { units });
  } catch (e) {
    b.close();
    toast(e.message || "That didn't work. Try again.", { ms: 6000 });
    if (e.code === "key" || e.code === "nokey") openAiSetup();
    return;
  }
  b.close();
  openAiPreview(description, r, onUse);
}

function openAiPreview(description, first, onUse) {
  let r = first;
  let name = r.name || description.slice(0, 40);
  const units = getUnits();
  const body = h(`<div class="ai-preview">
    <div class="ai-pic"></div>
    <label class="field"><span>Name</span><input class="input" name="nm" maxlength="40"></label>
    <div class="ai-size"><span>Size</span><b></b><button type="button" class="link">Change</button></div>
    <label class="field"><span>Want changes? Describe them and tap Try again</span><input class="input" name="chg" placeholder="For example: 5 panels instead of 4"></label>
    <p class="note">Try again sends your words to Claude again. Use it saves the block to My blocks on this phone.</p>
  </div>`);
  const pic = body.querySelector(".ai-pic");
  const sizeB = body.querySelector(".ai-size b");
  const nm = body.querySelector("[name=nm]");
  const chg = body.querySelector("[name=chg]");
  nm.value = name;
  const paint = () => { pic.innerHTML = previewSVG(r); sizeB.textContent = sizeText(r.w, r.d, units); };
  paint();
  body.querySelector(".ai-size .link").addEventListener("click", async () => {
    const cur = units === "ftin" ? sizeText(r.w, r.d, "ftin").replace(" × ", " x ") : `${Math.round(r.w)} x ${Math.round(r.d)}`;
    const t = await promptDialog({ title: "Block size", message: units === "ftin" ? "Width x depth, like 8'0\" x 2'0\"." : "Width x depth in mm, like 2400 x 600.", value: cur, okText: "Use", validate: (x) => (parseSizeText(x, units) ? null : "Type two sizes, like 2400 x 600.") });
    if (t == null) return;
    const sz = parseSizeText(t, units);
    const sx = sz.w / r.w, sy = sz.d / r.d;
    r = { ...r, w: sz.w, d: sz.d, parts: blockParts("custom", sz.w, sz.d, { w0: r.w, d0: r.d, parts: r.parts }) };
    void sx; void sy;
    paint();
  });
  const foot = h(`<div class="foot-row"><button class="btn" type="button" data-retry>${icon("sparkle")}<span>Try again</span></button><button class="btn primary" type="button" data-use>Use it</button></div>`);
  const sheet = openSheet({ title: "Your new block", body, foot, tall: true });
  foot.querySelector("[data-retry]").addEventListener("click", async () => {
    const btn = foot.querySelector("[data-retry]");
    btn.disabled = true;
    const span = btn.querySelector("span");
    span.textContent = "Drawing…";
    pic.classList.add("busy");
    try {
      const nr = await drawBlock(description, { units, change: chg.value.trim(), history: r.history || [] });
      if (nm.value.trim() === name && nr.name) { name = nr.name; nm.value = name; }
      r = nr;
      chg.value = "";
      paint();
    } catch (e) {
      toast(e.message || "That didn't work. Try again.", { ms: 6000 });
    } finally {
      btn.disabled = false;
      span.textContent = "Try again";
      pic.classList.remove("busy");
    }
  });
  foot.querySelector("[data-use]").addEventListener("click", () => {
    const saved = addMyBlock({ name: nm.value.trim() || name, w: r.w, d: r.d, parts: r.parts, src: "ai", prompt: description });
    if (!saved) { toast("The phone's storage for the app is full. Delete some of My blocks and try again.", { ms: 6000 }); return; }
    sheet.close();
    toast("Saved to My blocks");
    onUse && onUse(myTile(saved));
  });
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
  if (it.family === "custom" && it.p && it.p.w0) {
    return [{ i: 0, w: it.p.w0, d: it.p.d0, label: `Original · ${sizeText(it.p.w0, it.p.d0, units)}`, checked: Math.abs(it.p.w0 - it.bw) < 2 && Math.abs(it.p.d0 - it.bd) < 2, size: { w: it.p.w0, d: it.p.d0, p: it.p } }];
  }
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
