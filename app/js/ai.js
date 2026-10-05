// Custom blocks drawn by Claude. The only thing sent is the description you type (and, when you
// ask for a change, the previous drawing): never your PDF or your marks. It needs your own
// Claude API key, which is kept only on this phone.
import { settings } from "./platform.js";
import { partsFromSpec } from "./blocks.js";

const API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5-5";

export function aiKey() {
  const k = settings.get("ai-key", "");
  return typeof k === "string" ? k : "";
}
export function setAiKey(k) {
  settings.set("ai-key", String(k || "").trim());
}

const SYSTEM = `You draw architectural plan symbols (CAD blocks) for an architect's mobile mark-up app, used for Indian residential projects.

Reply with ONLY one JSON object, no other text:
{"name": "short name", "width": number, "depth": number, "elements": [ ... ]}

Coordinates are millimetres in PLAN VIEW. x goes right, y goes DOWN. The origin is the top-left corner of the block's bounding box, so everything lies between 0..width and 0..depth.
The back of the item is at the top (y = 0): the wall side of furniture (headboard, sofa back, WC cistern, cabinet back), and the wall line for doors, windows and openings. Doors hinge on the top edge and swing down into the room.
Draw at real size. Use typical sizes for Indian homes unless the request gives sizes.
Draw it like a clean AutoCAD block: outlines, panel and leaf divisions, swing arcs, fold lines, a few characteristic details. No hatching, no dimensions, no title. Only very short labels that are normal on plans (for example "UP" or "REF").

Element types:
{"type":"line","points":[[x,y],[x,y],...],"closed":false}
{"type":"rect","x":0,"y":0,"w":0,"h":0,"r":0}   (r is an optional corner radius)
{"type":"circle","cx":0,"cy":0,"r":0}
{"type":"ellipse","cx":0,"cy":0,"rx":0,"ry":0}
{"type":"arc","cx":0,"cy":0,"r":0,"start":0,"end":90}   (degrees; 0 points along +x, 90 along +y which is down; drawn from start to end)
{"type":"text","x":0,"y":0,"size":150,"text":"UP"}
Any element can have "dashed": true for things overhead (lofts, chimneys, beams), or "fill": true to hide lines under it with white (for example a table drawn over chair legs; put filled elements after what they cover).

Use between 3 and 150 elements.`;

export class AiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function extractJSON(text) {
  const t = String(text || "").replace(/```(?:json)?/gi, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new AiError("The drawing came back in a form the app can't read. Try again.", "parse");
  return JSON.parse(t.slice(a, b + 1));
}

/**
 * Asks Claude for a block. history: earlier turns [{ role, content }] for "change it" requests.
 * Returns { name, w, d, parts, json, history }.
 */
export async function drawBlock(description, { units = "mm", change = "", history = [], signal } = {}) {
  const key = aiKey();
  if (!key) throw new AiError("Add your Claude API key first.", "nokey");
  if (navigator.onLine === false) throw new AiError("You're offline. Connect to the internet and try again.", "offline");
  const unitNote = units === "ftin" ? "The architect thinks in feet and inches, but give every number in millimetres." : "Give every number in millimetres.";
  const messages = history.length
    ? [...history, { role: "user", content: `Change it: ${change || "draw it again, a little differently"}. Reply with the whole JSON again.` }]
    : [{ role: "user", content: `Draw this block: ${description}\n${unitNote}` }];
  let res;
  try {
    res = await fetch(API, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 6000, system: SYSTEM, messages })
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    throw new AiError("Couldn't reach Claude. Check your internet and try again.", "network");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || "";
    if (res.status === 401 || res.status === 403) throw new AiError("Claude didn't accept the API key. Check it in AI settings.", "key");
    if (res.status === 429 || res.status === 529 || res.status >= 500) throw new AiError("Claude is busy right now. Try again in a minute.", "busy");
    if (/credit|billing|balance/i.test(msg)) throw new AiError("Your Claude API account is out of credit. Add credit in the Claude Console.", "credit");
    if (/model/i.test(msg)) throw new AiError("The AI model isn't available to this API key.", "model");
    throw new AiError("Claude couldn't draw that. Try different words.", "failed");
  }
  const text = (data && Array.isArray(data.content) ? data.content : []).filter((c) => c.type === "text").map((c) => c.text).join("");
  let spec;
  try { spec = extractJSON(text); } catch (e) { throw e instanceof AiError ? e : new AiError("The drawing came back in a form the app can't read. Try again.", "parse"); }
  let out;
  try { out = partsFromSpec(spec); } catch (e) { throw new AiError("The drawing came back empty or the wrong size. Try again, maybe with more detail.", "empty"); }
  return { ...out, history: [...messages, { role: "assistant", content: JSON.stringify(spec) }] };
}
