// Small UI toolkit: icons, back-button aware layers, sheets, dialogs, toasts.

const PATHS = {
  back: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
  file: '<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>',
  combine: '<path d="M9 7V5a2 2 0 012-2h6l4 4v10a2 2 0 01-2 2h-2"/><rect x="3" y="7" width="12" height="14" rx="2"/><path d="M9 11v6M6 14h6"/>',
  view: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  pages: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 16.5l9 5 9-5"/>',
  rotl: '<path d="M4 4v5h5"/><path d="M5.1 9a8 8 0 1 1-.6 6"/>',
  rotr: '<path d="M20 4v5h-5"/><path d="M18.9 9a8 8 0 1 0 .6 6"/>',
  crop: '<path d="M6 2v14a2 2 0 002 2h14"/><path d="M2 6h14a2 2 0 012 2v14"/>',
  extract: '<path d="M13 3H7a2 2 0 00-2 2v14a2 2 0 002 2h5"/><path d="M13 3l6 6v3"/><path d="M15 18h7M19 15l3 3-3 3"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/><path d="M9 7V4h6v3"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
  download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'
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

const stack = [];

export function initHistory() {
  history.replaceState({ depth: 0 }, "");
  window.addEventListener("popstate", (e) => {
    const depth = (e.state && e.state.depth) || 0;
    while (stack.length > depth) {
      const top = stack[stack.length - 1];
      if (!top.force && top.canClose && top.canClose() === false) {
        for (let d = depth + 1; d <= stack.length; d++) history.pushState({ depth: d }, "");
        return;
      }
      stack.pop();
      try { top.onClose && top.onClose(); } catch (err) { console.error(err); }
    }
  });
}

export function pushLayer(layer) {
  stack.push(layer);
  history.pushState({ depth: stack.length }, "");
  return layer;
}

export function closeLayer(layer) {
  const i = stack.indexOf(layer);
  if (i < 0) return;
  for (let j = i; j < stack.length; j++) stack[j].force = true;
  history.go(-(stack.length - i));
}

export function isOpen(layer) {
  return stack.includes(layer);
}

/* ---------- Bottom sheet ---------- */

export function openSheet({ title, body, foot, tall = false, clear = false, onClose, tools }) {
  const ov = h(`<div class="overlay${clear ? " clear" : ""}">
    <div class="scrim"></div>
    <div class="sheet${tall ? " tall" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="ib" type="button" aria-label="Close">${icon("close")}</button></div>
    </div>
  </div>`);
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
