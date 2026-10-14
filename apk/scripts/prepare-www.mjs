// Copies the phone web app (../app) into www/, which Capacitor packs into the APK.
// The APK runs exactly the same files as https://surya-vallala.github.io/tesseract-pdf-tools/app/
import { cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "app");
const out = join(here, "..", "www");

if (!existsSync(join(src, "index.html"))) throw new Error("app/index.html not found");
rmSync(out, { recursive: true, force: true });
// The service worker and install manifest only matter in Chrome; the APK has its files built in.
cpSync(src, out, { recursive: true, filter: (p) => !/[\\/](sw\.js|manifest\.webmanifest)$/.test(p) });
console.log("Copied the phone app into www/");
