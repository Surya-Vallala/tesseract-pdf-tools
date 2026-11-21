// Photos and pictures the phone's browser can't read itself, turned into ones it can:
// HEIC / HEIF (iPhones and many Android phones) with libheif in heif-worker.js, and TIFF (scans,
// drawings) with the PDF engine. Used when opening files, adding pages, scanning and for pictures.

export class ConvertError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** "heic", "tiff" or null, from the first bytes of a file. */
export function convertibleKind(head) {
  const str = String.fromCharCode(...head.slice(0, 16));
  if (str.startsWith("II*\0") || str.startsWith("MM\0*")) return "tiff";
  if (str.slice(4, 8) === "ftyp") {
    const brand = str.slice(8, 12);
    if (/^(avif|avis)/.test(brand)) return null;
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand)) return "heic";
  }
  return null;
}

const renamed = (name, ext) => (name || "Photo").replace(/\.(heic|heif|tiff?)$/i, "") + ext;

/** The file itself if the browser can read it, otherwise a JPEG (HEIC) or PNG (TIFF) copy. */
export async function readableImage(file) {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const kind = convertibleKind(head);
  if (!kind) return file;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === "heic") {
    const { decodeHeif } = await import("./heif.js");
    let img;
    try {
      img = await decodeHeif(bytes);
    } catch (e) {
      throw new ConvertError(e.message === "offline"
        ? "Reading HEIC photos needs the internet once, to download the reader. Connect and try again."
        : "This HEIC photo couldn't be read.", e.message === "offline" ? "offline" : "heic");
    }
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext("2d").putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    const blob = await c.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    return new File([blob], renamed(file.name, ".jpg"), { type: "image/jpeg", lastModified: file.lastModified });
  }
  const { engine } = await import("./engine.js");
  let r;
  try {
    r = await engine("imagePng", [bytes]);
  } catch (e) {
    throw new ConvertError(e && e.code === "offline" ? e.message : "This TIFF picture couldn't be read.", e && e.code === "offline" ? "offline" : "tiff");
  }
  return new File([r.bytes], renamed(file.name, ".png"), { type: "image/png", lastModified: file.lastModified });
}
