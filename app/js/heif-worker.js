// Reads HEIC / HEIF photos (the default on iPhones and many Android phones) off the main thread,
// with libheif (LGPL-3.0, vendor/libheif). Loaded only when such a photo is picked.
import libheif from "../vendor/libheif/libheif-bundle.mjs";

let lib = null;

self.onmessage = async (e) => {
  const { id, bytes } = e.data;
  try {
    if (!lib) lib = await libheif();
    const decoder = new lib.HeifDecoder();
    const images = decoder.decode(bytes);
    if (!images || !images.length) throw new Error("no image");
    const img = images[0]; // the primary image
    const width = img.get_width(), height = img.get_height();
    const data = await new Promise((resolve, reject) => {
      img.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (d) => (d ? resolve(d.data) : reject(new Error("decode"))));
    });
    for (const x of images) if (x.free) x.free();
    self.postMessage({ id, ok: true, width, height, data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
