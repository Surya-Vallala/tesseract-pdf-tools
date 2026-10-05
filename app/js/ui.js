// Small UI toolkit: icons, back-button aware layers, sheets, dialogs, toasts.

const PATHS = {
  back: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
  file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  combine: '<path d="M9 7V5a2 2 0 012-2h6l4 4v10a2 2 0 01-2 2h-2"/><rect x="3" y="7" width="12" height="14" rx="2"/><path d="M9 11v6M6 14h6"/>',
  view: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  pages: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  markup: '<path d="M4 20l1-4L16 5a2.1 2.1 0 013 3L8 19z"/><path d="M14 7l3 3"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 16.5l9 5 9-5"/>',
  tools: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V5h6v3"/><path d="M3 13h18"/><path d="M10 13v2h4v-2"/>',
  rotl: '<path d="M4 4v5h5"/><path d="M5.1 9a8 8 0 1 1-.6 6"/>',
  rotr: '<path d="M20 4v5h-5"/><path d="M18.9 9a8 8 0 1 0 .6 6"/>',
  crop: '<path d="M6 2v14a2 2 0 002 2h14"/><path d="M2 6h14a2 2 0 012 2v14"/>',
  extract: '<path d="M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h5"/><path d="M13 3l6 6v3"/><path d="M15 18h7M19 15l3 3-3 3"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/><path d="M9 7V4h6v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
  download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  chevdown: '<path d="M6 9l6 6 6-6"/>',
  select: '<path d="M6 3l12 9-6 1-3 6z"/>',
  pen: '<path d="M4 20l1-4L16 5a2.1 2.1 0 013 3L8 19z"/>',
  eraser: '<path d="M16 4l5 5-10 10H6l-3-3z"/><path d="M9 9l6 6"/><path d="M11 19h10"/>',
  blur: '<circle cx="7" cy="7" r="1.6"/><circle cx="12" cy="7" r="1.6"/><circle cx="17" cy="7" r="1.6"/><circle cx="7" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="17" cy="12" r="1.6"/><circle cx="7" cy="17" r="1.6"/><circle cx="12" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/>',
  shapes: '<rect x="3" y="13" width="8" height="8" rx="1"/><circle cx="17" cy="7" r="4"/><path d="M14 21l3.5-6 3.5 6z"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  watermark: '<path d="M12 3s6 6.5 6 11a6 6 0 01-12 0c0-4.5 6-11 6-11z"/>',
  compress: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>',
  split: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1L20 20"/><path d="M8.1 15.9L20 4"/>',
  ocr: '<path d="M4 8V5a1 1 0 011-1h3"/><path d="M16 4h3a1 1 0 011 1v3"/><path d="M20 16v3a1 1 0 01-1 1h-3"/><path d="M8 20H5a1 1 0 01-1-1v-3"/><path d="M8 9h8M8 12h8M8 15h5"/>',
  textfile: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0122 12s-1 2-3 3.9M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.5 4.5-1.2"/><path d="M9.9 9.9a3 3 0 004.2 4.2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
  text: '<path d="M5 7V4h14v3"/><path d="M12 4v16"/><path d="M9 20h6"/>',
  arrow: '<path d="M5 19L19 5"/><path d="M10 5h9v9"/>',
  curved: '<path d="M4 19c1-8 7-13 15-13"/><path d="M15 2.5l4 3.5-3.5 4"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  polygon: '<path d="M12 3l8 5v8l-8 5-8-5V8z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  north: '<circle cx="12" cy="13" r="8"/><path d="M12 3.5l3 10.5-3-2-3 2z"/>',
  section: '<circle cx="10" cy="12" r="6"/><path d="M4 12h12"/><path d="M16 12h5"/><path d="M18 9l3 3-3 3"/>',
  level: '<path d="M3 18h18"/><path d="M8 11h8l-4 7z"/><path d="M13 8h7"/>',
  box: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
  free: '<path d="M4 16c2-6 5-9 7-7s-1 7 2 7 4-6 7-8"/>',
  leader: '<path d="M4 20l7-7"/><path d="M4 20l1-4M4 20l4-1"/><rect x="12" y="4" width="9" height="7" rx="1"/>',
  blank: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/>',
  tostart: '<path d="M5 4v16"/><path d="M19 12H9"/><path d="M13 8l-4 4 4 4"/>',
  toend: '<path d="M19 4v16"/><path d="M5 12h10"/><path d="M11 8l4 4-4 4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  ruler: '<path d="M3 15.5L15.5 3 21 8.5 8.5 21z"/><path d="M7 11.5l2 2M10 8.5l1.5 1.5M13 5.5l2 2"/>',
  size: '<path d="M4 9V4h5"/><path d="M20 15v5h-5"/><path d="M4 4l7 7"/><path d="M20 20l-7-7"/>',
  turn: '<path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 4v5h-5"/>',
  flip: '<path d="M12 3v18"/><path d="M9 7L4 17h5z"/><path d="M15 7l5 10h-5z"/>'
};

export function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ""}</svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((n) => {
    n.innerHTML = icon(n.dataset.icon);
    n.removeAttribute("data-icon");
  });
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/* ---------- Layers that close with the Android back button ---------- */

// Each open layer (sheet, dialog, file) has a history entry, so the phone's Back gesture
// closes the top one. Closing from a button happens straight away; the matching history
// step runs afterwards, one at a time, so opening something new right after closing
// something else is safe.
const stack = [];
let hDepth = 0;        // layer entries the history will have once pending steps finish
let inFlight = false;  // a history.go() we started hasn't arrived yet
let owed = 0;          // entries still to step back over

function syncHistory(depth) {
  for (let d = depth + 1; d <= stack.length; d++) history.pushState({ depth: d }, "");
  hDepth = Math.max(depth, stack.length);
}

function flush() {
  if (inFlight || !owed) return;
  inFlight = true;
  const n = owed;
  owed = 0;
  history.go(-n);
}

export function initHistory() {
  history.replaceState({ depth: 0 }, "");
  window.addEventListener("popstate", (e) => {
    const depth = (e.state && e.state.depth) || 0;
    if (inFlight) {
      inFlight = false;
      if (owed) flush();
      else syncHistory(Math.min(depth, stack.length));
      return;
    }
    // The Back gesture.
    while (stack.length > depth) {
      const top = stack[stack.length - 1];
      if (top.canClose && top.canClose() === false) break;
      stack.pop();
      try { top.onClose && top.onClose(); } catch (err) { console.error(err); }
    }
    syncHistory(Math.min(depth, stack.length));
  });
}

export function pushLayer(layer) {
  stack.push(layer);
  if (!inFlight && !owed) {
    history.pushState({ depth: stack.length }, "");
    hDepth = stack.length;
  }
  return layer;
}

export function closeLayer(layer) {
  const i = stack.indexOf(layer);
  if (i < 0) return;
  const closing = stack.splice(i);
  for (let j = closing.length - 1; j >= 0; j--) {
    try { closing[j].onClose && closing[j].onClose(); } catch (err) { console.error(err); }
  }
  if (hDepth > stack.length) {
    owed += hDepth - stack.length;
    hDepth = stack.length;
    flush();
  }
}

export function isOpen(layer) {
  return stack.includes(layer);
}

/* ---------- Bottom sheet ---------- */

export function openSheet({ title, body, foot, tall = false, full = false, clear = false, onClose, tools, headExtra }) {
  const ov = h(`<div class="overlay${clear ? " clear" : ""}">
    <div class="scrim"></div>
    <div class="sheet${tall ? " tall" : ""}${full ? " full" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="ib" type="button" aria-label="Close">${icon("close")}</button></div>
    </div>
  </div>`);
  if (headExtra) ov.querySelector(".sheet-head h2").after(headExtra);
  const sheet = ov.querySelector(".sheet");
  if (tools) sheet.appendChild(tools);
  const bodyEl = document.createElement("div");
  bodyEl.className = "sheet-body";
  if (body) bodyEl.appendChild(body);
  sheet.appendChild(bodyEl);
  if (foot) {
    const f = document.createElement("div");
    f.className = "sheet-foot";
    f.appendChild(foot);
    sheet.appendChild(f);
  }
  document.body.appendChild(ov);
  const layer = pushLayer({ onClose: () => { ov.remove(); onClose && onClose(); } });
  const close = () => closeLayer(layer);
  ov.querySelector(".scrim").addEventListener("click", close);
  ov.querySelector(".sheet-head .ib").addEventListener("click", close);
  return { el: ov, sheet, body: bodyEl, close, layer };
}

/* ---------- Dialogs ---------- */

export function confirmDialog({ title, message, okText = "OK", cancelText = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const ov = h(`<div class="overlay"><div class="scrim"></div>
      <div class="dialog" role="alertdialog" aria-modal="true">
        <h2>${esc(title)}</h2>${message ? `<p>${esc(message)}</p>` : ""}
        <div class="actions">
          ${cancelText ? `<button class="btn" type="button" data-r="0">${esc(cancelText)}</button>` : ""}
          <button class="btn ${danger ? "danger" : "primary"}" type="button" data-r="1">${esc(okText)}</button>
        </div>
      </div></div>`);
    document.body.appendChild(ov);
    const layer = pushLayer({ onClose: () => { ov.remove(); resolve(result); } });
    ov.querySelector(".scrim").addEventListener("click", () => closeLayer(layer));
    ov.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
      result = b.dataset.r === "1";
      closeLayer(layer);
    }));
    ov.querySelector('[data-r="1"]').focus();
  });
}

export function passwordDialog(fileName, retry) {
  return new Promise((resolve) => {
    let result = null;
    const ov = h(`<div class="overlay"><div class="scrim"></div>
      <form class="dialog" role="dialog" aria-modal="true" autocomplete="off">
        <h2>Password needed</h2>
        <p>${retry ? "That password didn't work. Try again." : `“${esc(fileName)}” is protected with a password.`}</p>
        <input class="input" type="password" name="pw" autocomplete="off" aria-label="Password" enterkeyhint="done">
        <div class="actions">
          <button class="btn" type="button" data-cancel>Cancel</button>
          <button class="btn primary" type="submit">Open</button>
        </div>
      </form></div>`);
    document.body.appendChild(ov);
    const layer = pushLayer({ onClose: () => { ov.remove(); resolve(result); } });
    const form = ov.querySelector("form");
    const input = form.querySelector("input");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      result = input.value;
      closeLayer(layer);
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => closeLayer(layer));
    ov.querySelector(".scrim").addEventListener("click", () => closeLayer(layer));
    setTimeout(() => input.focus(), 50);
  });
}

/* ---------- Toasts and busy indicator ---------- */

export function toast(text, { action, ms = 3500 } = {}) {
  const host = document.getElementById("toasts");
  const t = h(`<div class="toast" role="status"><span>${esc(text)}</span></div>`);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", () => { t.remove(); action.fn(); });
    t.appendChild(b);
  }
  host.appendChild(t);
  while (host.children.length > 2) host.firstElementChild.remove();
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

export function busy(text) {
  const ov = h(`<div class="busy" role="alert" aria-busy="true"><div><span class="spin"></span><span>${esc(text)}</span></div></div>`);
  const shownAt = Date.now();
  const timer = setTimeout(() => document.body.appendChild(ov), 180);
  return {
    set(t) { ov.querySelector("span:last-child").textContent = t; },
    close() {
      clearTimeout(timer);
      const wait = ov.isConnected ? Math.max(0, 350 - (Date.now() - shownAt - 180)) : 0;
      setTimeout(() => ov.remove(), wait);
    }
  };
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}


/* ---------- More dialogs and menus ---------- */

export function promptDialog({ title, message = "", label = "", value = "", okText = "OK", multiline = false, placeholder = "", validate }) {
  return new Promise((resolve) => {
    let result = null;
    const ov = h(`<div class="overlay"><div class="scrim"></div>
      <form class="dialog" role="dialog" aria-modal="true" autocomplete="off">
        <h2>${esc(title)}</h2>${message ? `<p>${esc(message)}</p>` : ""}
        <label class="field" style="margin:0">${label ? `<span>${esc(label)}</span>` : ""}
          ${multiline
            ? `<textarea class="input" rows="3" name="v" placeholder="${esc(placeholder)}" style="min-height:84px;resize:none"></textarea>`
            : `<input class="input" name="v" placeholder="${esc(placeholder)}" enterkeyhint="done">`}
        </label>
        <p class="form-error" hidden></p>
        <div class="actions">
          <button class="btn" type="button" data-cancel>Cancel</button>
          <button class="btn primary" type="submit">${esc(okText)}</button>
        </div>
      </form></div>`);
    document.body.appendChild(ov);
    const layer = pushLayer({ onClose: () => { ov.remove(); resolve(result); } });
    const form = ov.querySelector("form");
    const input = form.querySelector("[name=v]");
    const err = form.querySelector(".form-error");
    input.value = value;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = input.value;
      const problem = validate ? validate(v) : null;
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      result = v;
      closeLayer(layer);
    });
    form.querySelector("[data-cancel]").addEventListener("click", () => closeLayer(layer));
    ov.querySelector(".scrim").addEventListener("click", () => closeLayer(layer));
    setTimeout(() => { input.focus(); if (!multiline) input.select(); }, 60);
  });
}

/** A small menu next to a button. items: [{ label, icon, value, danger, checked }] */
export function openMenu(anchor, items, { align = "end", above = null } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const ov = h(`<div class="overlay clear"><div class="scrim"></div><div class="menu" role="menu"></div></div>`);
    const menu = ov.querySelector(".menu");
    for (const it of items) {
      if (it.divider) { menu.appendChild(h(`<div class="menu-div"></div>`)); continue; }
      const b = h(`<button type="button" role="menuitem" class="menu-item${it.danger ? " danger" : ""}">
        ${it.icon ? icon(it.icon) : ""}<span>${esc(it.label)}</span>${it.checked ? icon("check") : ""}</button>`);
      b.addEventListener("click", () => { result = it.value; closeLayer(layer); });
      menu.appendChild(b);
    }
    document.body.appendChild(ov);
    const r = anchor.getBoundingClientRect();
    const mw = Math.min(280, window.innerWidth - 16);
    menu.style.width = mw + "px";
    const mh = menu.offsetHeight;
    let left = align === "end" ? r.right - mw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
    const goAbove = above != null ? above : r.bottom + mh + 8 > window.innerHeight;
    menu.style.left = left + "px";
    menu.style.top = (goAbove ? Math.max(8, r.top - mh - 6) : r.bottom + 6) + "px";
    const layer = pushLayer({ onClose: () => { ov.remove(); resolve(result); } });
    ov.querySelector(".scrim").addEventListener("click", () => closeLayer(layer));
  });
}

export function switchHTML(on, mixed = false) {
  return `<span class="switch${on ? " on" : ""}${mixed ? " mixed" : ""}" aria-hidden="true"></span>`;
}

/** Segmented control. options: [{ value, label }]; returns the element; onChange(value). */
export function segmented(options, value, onChange, { small = false, label = "" } = {}) {
  const el = h(`<div class="seg${small ? " small" : ""}" role="radiogroup"${label ? ` aria-label="${esc(label)}"` : ""}></div>`);
  const paint = (v) => el.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.v === String(v);
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on ? "true" : "false");
  });
  for (const o of options) {
    const b = h(`<button type="button" role="radio" data-v="${esc(o.value)}">${esc(o.label)}</button>`);
    b.addEventListener("click", () => { paint(o.value); onChange && onChange(o.value); });
    el.appendChild(b);
  }
  paint(value);
  el.setValue = paint;
  return el;
}
