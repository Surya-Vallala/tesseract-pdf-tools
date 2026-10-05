// "Only what's visible": take the content of hidden layers out of a PDF for good.
// Reads each page's drawing instructions and drops the parts marked as a hidden layer.

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(c) {
  return !WS.has(c) && !DELIM.has(c);
}

/**
 * Filter a content stream.
 * isHiddenProp(name) -> true when /OC /name refers to a hidden layer
 * onDo(name) -> "drop" to remove a Do of that XObject, anything else to keep it
 */
export function filterContent(bytes, isHiddenProp, onDo) {
  const n = bytes.length;
  let i = 0;
  const keep = [];
  let keptFrom = 0;
  let depth = 0;
  let operands = [];
  let opStart = -1;
  let skip = 0;
  let changed = false;

  const drop = (from, to) => {
    if (from > keptFrom) {
      const part = bytes.subarray(keptFrom, from);
      if (part.some((b) => !WS.has(b))) keep.push(part);
    }
    keptFrom = to;
    changed = true;
  };

  while (i < n) {
    let c = bytes[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i++; continue; }
    const start = i;
    if (opStart < 0) opStart = start;
    if (c === 0x28) {
      let lvl = 1; i++;
      while (i < n && lvl > 0) {
        const d = bytes[i];
        if (d === 0x5c) { i += 2; continue; }
        if (d === 0x28) lvl++;
        else if (d === 0x29) lvl--;
        i++;
      }
      if (depth === 0) operands.push({ t: "str" });
      continue;
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) { depth++; i += 2; continue; }
      while (i < n && bytes[i] !== 0x3e) i++;
      i++;
      if (depth === 0) operands.push({ t: "hex" });
      continue;
    }
    if (c === 0x3e) {
      if (bytes[i + 1] === 0x3e) { depth = Math.max(0, depth - 1); i += 2; if (depth === 0) operands.push({ t: "dict" }); continue; }
      i++; continue;
    }
    if (c === 0x5b) { depth++; i++; continue; }
    if (c === 0x5d) { depth = Math.max(0, depth - 1); i++; if (depth === 0) operands.push({ t: "arr" }); continue; }
    if (c === 0x7b || c === 0x7d) { i++; continue; }
    if (c === 0x2f) {
      i++;
      const s = i;
      while (i < n && isRegular(bytes[i])) i++;
      if (depth === 0) operands.push({ t: "name", v: decodeName(bytes.subarray(s, i)) });
      continue;
    }
    // number or operator
    while (i < n && isRegular(bytes[i])) i++;
    const word = latin1(bytes.subarray(start, i));
    if (/^[+\-.\d]/.test(word) || word === "true" || word === "false" || word === "null") {
      if (depth === 0) operands.push({ t: "num" });
      continue;
    }
    if (depth > 0) continue;
    // operator
    let opEnd = i;
    if (word === "BI") {
      // inline image: skip to "EI" that follows whitespace after the data
      let j = i;
      while (j < n - 1 && !(bytes[j] === 0x49 && bytes[j + 1] === 0x44 && WS.has(bytes[j - 1]) && (j + 2 >= n || WS.has(bytes[j + 2])))) j++;
      j += 3;
      while (j < n - 1) {
        const pre = bytes[j - 1];
        if (bytes[j] === 0x45 && bytes[j + 1] === 0x49 && (pre === 0x20 || pre === 0x0a || pre === 0x0d || pre === 0x09) && (j + 2 >= n || WS.has(bytes[j + 2]) || DELIM.has(bytes[j + 2]))) { j += 2; break; }
        j++;
      }
      opEnd = j;
      i = j;
    }
    const from = opStart;
    if (skip > 0) {
      if (word === "BDC" || word === "BMC") skip++;
      else if (word === "EMC") skip--;
      drop(from, opEnd);
    } else if (word === "BDC" && operands.length >= 2 && operands[0].t === "name" && operands[0].v === "OC" && operands[1].t === "name" && isHiddenProp(operands[1].v)) {
      skip = 1;
      drop(from, opEnd);
    } else if (word === "Do" && operands.length && operands[operands.length - 1].t === "name") {
      if (onDo(operands[operands.length - 1].v) === "drop") drop(from, opEnd);
    }
    operands = [];
    opStart = -1;
  }
  if (!changed) return null;
  if (keptFrom < n) keep.push(bytes.subarray(keptFrom));
  let len = 0;
  for (const k of keep) len += k.length + 1;
  const out = new Uint8Array(len);
  let o = 0;
  for (const k of keep) { out.set(k, o); o += k.length; out[o++] = 0x0a; }
  return out;
}

function latin1(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function decodeName(b) {
  return latin1(b).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
