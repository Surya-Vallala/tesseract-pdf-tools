// Comments: your name, the comment bubble on a pin, and the list of all comments.
import { h, esc, icon, openSheet, promptDialog, openMenu, pushLayer, closeLayer, toast, confirmDialog } from "./ui.js";
import { settings } from "./platform.js";
import { sizeLeader } from "./markup.js";

const TYPE_LABEL = { box: "Box", free: "Freehand", leader: "Leader" };
const TYPE_ICON = { box: "box", free: "free", leader: "leader" };

export async function askAuthor() {
  const saved = settings.get("author", "");
  if (saved) return saved;
  const v = await promptDialog({
    title: "Your name for comments",
    message: "It's shown with each comment you add, here and in other PDF apps.",
    label: "Name",
    value: "",
    okText: "Continue",
    validate: (x) => (x.trim() ? null : "Type a name to continue.")
  });
  if (v == null) return null;
  settings.set("author", v.trim());
  return v.trim();
}

export function when(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (sameDay) return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
  if (yest) return "Yesterday";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export async function editComment(doc, page, id, onChange) {
  const item = page.items.find((x) => x.id === id);
  if (!item) return;
  const v = await promptDialog({ title: "Edit comment", value: item.text, multiline: true, okText: "Save" });
  if (v == null || !v.trim()) return;
  doc.commit();
  item.text = v.trim();
  item.modified = Date.now();
  if (item.ctype === "leader") sizeLeader(item);
  onChange();
}

export function deleteComment(doc, page, id, onChange) {
  doc.commit();
  page.items = page.items.filter((x) => x.id !== id);
  onChange();
  toast("Comment deleted", { ms: 3000, action: { label: "Undo", fn: () => doc.undo() } });
}

/** The bubble shown when you tap a comment pin. */
export function openBubble(doc, page, id, anchorEl, onChange) {
  const item = page.items.find((x) => x.id === id);
  if (!item) return;
  const ov = h(`<div class="overlay clear"><div class="scrim"></div>
    <div class="bubble" role="dialog" aria-label="Comment">
      <div class="bubble-meta"><span class="dot" style="background:${item.color}"></span>${esc(item.author || "")}${item.author ? " · " : ""}${esc(when(item.modified || item.created))}</div>
      <p class="bubble-text"></p>
      <div class="bubble-actions">
        <button type="button" class="btn small" data-a="edit">${icon("edit")}<span>Edit</span></button>
        <button type="button" class="btn small danger-text" data-a="delete">${icon("trash")}<span>Delete</span></button>
      </div>
    </div></div>`);
  ov.querySelector(".bubble-text").textContent = item.text;
  document.body.appendChild(ov);
  const bub = ov.querySelector(".bubble");
  const r = anchorEl.getBoundingClientRect();
  const bw = Math.min(320, window.innerWidth - 24);
  bub.style.width = bw + "px";
  const left = Math.max(12, Math.min(r.left + r.width / 2 - bw / 2, window.innerWidth - bw - 12));
  bub.style.left = left + "px";
  const bh = bub.offsetHeight;
  bub.style.top = (r.bottom + 8 + bh < window.innerHeight - 70 ? r.bottom + 8 : Math.max(8, r.top - bh - 8)) + "px";
  const layer = pushLayer({ onClose: () => ov.remove() });
  ov.querySelector(".scrim").addEventListener("click", () => closeLayer(layer));
  ov.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", () => {
    closeLayer(layer);
    if (b.dataset.a === "edit") editComment(doc, page, id, onChange);
    else deleteComment(doc, page, id, onChange);
  }));
}

/** All comments: yours, and those already in the PDF. */
export async function openCommentsList(doc, { onGo, onChange, onToggle }) {
  const body = h(`<div class="comments-body"><ul class="comment-list"></ul><p class="note" style="padding:0 18px">Tap a comment to go to it. Press and hold one of yours to edit or delete it.</p></div>`);
  const sw = h(`<button type="button" role="switch" class="head-switch"><span>Show on pages</span><span class="switch"></span></button>`);
  const sheet = openSheet({ title: "Comments", body, headExtra: sw });
  sheet.body.style.padding = "0";
  const paintSwitch = () => {
    sw.setAttribute("aria-checked", doc.commentsVisible);
    sw.querySelector(".switch").classList.toggle("on", doc.commentsVisible);
  };
  sw.addEventListener("click", () => { doc.commentsVisible = !doc.commentsVisible; paintSwitch(); onToggle(); });
  paintSwitch();

  const ul = body.querySelector("ul");
  const render = async () => {
    const mine = doc.comments();
    const theirs = [];
    for (let i = 0; i < doc.pages.length; i++) {
      const p = doc.pages[i];
      const s = doc.src(p);
      if (s.kind !== "pdf") continue;
      try {
        const page = await s.pdf.getPage(p.index + 1);
        const annots = await page.getAnnotations();
        for (const a of annots) {
          const text = (a.contentsObj && a.contentsObj.str) || "";
          if (!text || a.subtype === "Link" || a.subtype === "Widget" || a.subtype === "Popup") continue;
          theirs.push({ index: i, page: p, text, author: (a.titleObj && a.titleObj.str) || "", type: a.subtype, color: a.color });
        }
      } catch (e) { /* skip */ }
    }
    const rows = [
      ...mine.map((c) => ({ mine: true, index: c.index, page: c.page, item: c.item })),
      ...theirs.map((t) => ({ mine: false, ...t }))
    ].sort((a, b) => a.index - b.index);
    if (!rows.length) {
      ul.innerHTML = `<li class="layer-empty">No comments yet. Add one in Mark up, with Comment.</li>`;
      return;
    }
    ul.innerHTML = "";
    for (const r of rows) {
      let li;
      if (r.mine) {
        const it = r.item;
        li = h(`<li><button type="button" class="comment-row"><span class="ctype" style="background:${it.color}">${icon(TYPE_ICON[it.ctype])}</span>
          <span class="ctext"><small>Page ${r.index + 1} · ${TYPE_LABEL[it.ctype]} · ${esc(it.author || "")} · ${esc(when(it.modified || it.created))}</small><span></span></span></button></li>`);
        li.querySelector(".ctext > span").textContent = it.text;
      } else {
        const col = r.color && r.color.length >= 3 ? `rgb(${r.color[0]},${r.color[1]},${r.color[2]})` : "#6B6B66";
        li = h(`<li><button type="button" class="comment-row"><span class="ctype" style="background:${col}">${icon("comment")}</span>
          <span class="ctext"><small>Page ${r.index + 1} · From the PDF${r.author ? " · " + esc(r.author) : ""}</small><span></span></span></button></li>`);
        li.querySelector(".ctext > span").textContent = r.text;
      }
      const btn = li.querySelector("button");
      let timer = 0, held = false;
      btn.addEventListener("pointerdown", () => {
        held = false;
        if (!r.mine) return;
        timer = setTimeout(async () => {
          held = true;
          const v = await openMenu(btn, [{ label: "Edit", value: "edit", icon: "edit" }, { label: "Delete", value: "delete", icon: "trash", danger: true }]);
          if (v === "edit") await editComment(doc, r.page, r.item.id, () => { onChange(); render(); });
          if (v === "delete") { deleteComment(doc, r.page, r.item.id, onChange); render(); }
        }, 450);
      });
      ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => btn.addEventListener(ev, () => clearTimeout(timer)));
      btn.addEventListener("contextmenu", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        if (held) return;
        sheet.close();
        onGo(r.page, r.mine ? r.item.id : null);
      });
      ul.appendChild(li);
    }
  };
  render();
  return sheet;
}
