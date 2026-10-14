// Runs on GitHub's build machine against the debug APK in an Android emulator.
// Checks the things only the APK does: start-up, saving to Downloads, "Open with",
// the share menu and the Back button. Writes screenshots, logcat and report.json.
import { _android as android } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] || "test-out";
const PKG = "co.tesseractstudio.pdftools";
mkdirSync(OUT, { recursive: true });

const report = { started: new Date().toISOString(), steps: [] };
function step(name, ok, info) {
  report.steps.push({ name, ok: !!ok, info });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`, info === undefined ? "" : JSON.stringify(info));
}
const adb = (cmd) => {
  try {
    return execSync(`adb ${cmd}`, { encoding: "utf8", timeout: 60000 });
  } catch (e) {
    return `ERROR ${e.message}`;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let device;
try {
  [device] = await android.devices();
  adb(`shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${PKG}/.MainActivity`);
  const webview = await device.webView({ pkg: PKG }, { timeout: 90000 });
  const page = await webview.page();
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") report.console = [...(report.console || []), `[${m.type()}] ${m.text()}`]; });
  page.on("pageerror", (e) => { report.console = [...(report.console || []), `[pageerror] ${e.message}`]; });
  await page.waitForSelector("#home", { timeout: 60000 });
  await sleep(4000);
  await device.screenshot({ path: `${OUT}/1-home.png` });

  const s1 = await page.evaluate(() => ({
    native: !!(window.Capacitor && window.Capacitor.isNativePlatform()),
    home: !document.getElementById("home").hidden,
    installCardHidden: document.getElementById("installCard").hidden,
    shareTipShown: !document.getElementById("shareTip").hidden,
    version: document.getElementById("appVersion").textContent,
    serviceWorker: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    oldEngineNotice: !document.getElementById("oldEngine").hidden,
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    ua: navigator.userAgent
  }));
  step("App starts on the home screen", s1.native && s1.home && s1.installCardHidden && !s1.serviceWorker, s1);

  // Make a small 2-page PDF inside the app and save it to Downloads the way the Save sheet does.
  const savedName = await page.evaluate(async () => {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "vendor/pdf-lib.min.js";
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
    const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 2; i++) {
      const p = doc.addPage([595, 842]);
      p.drawRectangle({ x: 60, y: 60, width: 475, height: 722, borderColor: rgb(0.8, 0, 0), borderWidth: 3 });
      p.drawText(`APK test page ${i}`, { x: 90, y: 740, size: 28, font });
    }
    const bytes = await doc.save();
    const { downloadFile } = await import("./js/platform.js");
    return downloadFile(new File([bytes], "apk-test.pdf", { type: "application/pdf" }));
  });
  const listing = adb("shell ls -l /sdcard/Download/");
  step("Save puts the PDF in Downloads", listing.includes(savedName), { savedName, listing });

  // "Open with": hand that file back to the app through Android, like tapping it in My Files.
  const rows = adb(`shell content query --uri content://media/external/downloads --projection _id:_display_name`);
  const m = rows.split("\n").map((l) => l.match(/_id=(\d+), _display_name=(.*)$/)).filter(Boolean).find((x) => x[2].trim() === savedName);
  if (m) {
    adb(`shell am start -a android.intent.action.VIEW -t application/pdf -d content://media/external/downloads/${m[1]} -n ${PKG}/.MainActivity`);
    let opened = null;
    for (let i = 0; i < 30 && !(opened && opened.doc); i++) {
      await sleep(1000);
      opened = await page.evaluate(() => ({
        doc: !document.getElementById("docScreen").hidden,
        pages: window.__tpt && window.__tpt.doc ? window.__tpt.doc.pages.length : 0,
        name: window.__tpt && window.__tpt.doc ? window.__tpt.doc.name : ""
      })).catch((e) => ({ error: e.message }));
    }
    await sleep(2500);
    await device.screenshot({ path: `${OUT}/2-opened.png` });
    step("Open with: the app opens a PDF from Downloads", opened && opened.doc && opened.pages === 2, opened);

    // Back button: one tap on the page first (Chrome only lets a page add Back steps after a touch).
    const size = adb("shell wm size").match(/(\d+)x(\d+)/);
    const w = size ? +size[1] : 1080, h = size ? +size[2] : 2400;
    adb(`shell input tap ${Math.round(w / 2)} ${Math.round(h * 0.55)}`);
    await sleep(800);
    adb("shell input keyevent 4");
    await sleep(1500);
    const afterBack = await page.evaluate(() => ({
      home: !document.getElementById("home").hidden,
      doc: !document.getElementById("docScreen").hidden,
      dialog: !!document.querySelector(".dialog")
    }));
    await device.screenshot({ path: `${OUT}/3-after-back.png` });
    step("Back closes the file and returns to the home screen", afterBack.home && !afterBack.doc, afterBack);
  } else {
    step("Open with: the app opens a PDF from Downloads", false, { rows });
  }

  // Share menu opens, and closing it reports "cancelled" to the app.
  await page.evaluate(() => {
    window.__shareResult = "pending";
    import("./js/platform.js")
      .then((m) => m.shareFiles([new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10])], "share-test.pdf", { type: "application/pdf" })], "share-test.pdf"))
      .then((r) => { window.__shareResult = r; }, (e) => { window.__shareResult = "error: " + (e && e.message); });
  });
  await sleep(4000);
  await device.screenshot({ path: `${OUT}/4-share-sheet.png` });
  const focus = adb("shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'");
  adb("shell input keyevent 4");
  await sleep(2500);
  const shareResult = await page.evaluate(() => window.__shareResult);
  step("Share opens Android's share menu and closing it is understood", /chooser|resolver|ChooserActivity|intentresolver/i.test(focus) && shareResult === "cancelled", { focus: focus.trim(), shareResult });

  // Check for updates, as the person would: About, Check for updates, Check.
  await page.click("#btnAbout");
  await sleep(800);
  await page.click("[data-update]");
  await sleep(800);
  await device.screenshot({ path: `${OUT}/5-update-ask.png` });
  await page.click('.dialog [data-r="1"]');
  let updToast = "";
  for (let i = 0; i < 20 && !/version|update/i.test(updToast); i++) {
    await sleep(700);
    updToast = await page.evaluate(() => [...document.querySelectorAll(".toast, .sheet h2")].map((t) => t.textContent).join(" | "));
  }
  await device.screenshot({ path: `${OUT}/6-update-result.png` });
  step("Check for updates asks first, then reads version.json", /latest version|Update available/.test(updToast), updToast);
  await page.evaluate(() => { document.querySelectorAll(".sheet-head .ib").forEach((b) => b.click()); });
  await sleep(500);

  // Downloading an update: fetch the published APK, check it, and hand it to Android's installer.
  adb(`shell appops set ${PKG} REQUEST_INSTALL_PACKAGES allow`);
  await page.evaluate(() => {
    window.__upd = "pending";
    import("./js/native.js")
      .then(async (m) => { const info = await m.fetchUpdateInfo(); await m.installUpdate(info); return "installer"; })
      .then((r) => { window.__upd = r; }, (e) => { window.__upd = "error: " + (e && (e.code || e.message)); });
  });
  let upd = "pending";
  for (let i = 0; i < 60 && upd === "pending"; i++) {
    await sleep(1000);
    upd = await page.evaluate(() => window.__upd).catch(() => "page gone");
  }
  await sleep(2500);
  await device.screenshot({ path: `${OUT}/7-installer.png` });
  const instFocus = adb("shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'");
  step("Update download is checked and Android's installer opens", upd === "installer" && /packageinstaller/i.test(instFocus), { upd, focus: instFocus.trim() });
  adb("shell input keyevent 4");
  await sleep(2000);

  // Back on the home screen leaves the app (it goes to the background, not crash).
  adb("shell input keyevent 4");
  await sleep(2000);
  const top = adb("shell dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity' | head -3");
  step("Back on the home screen leaves the app", !top.includes(`${PKG}/`), top.trim());
} catch (e) {
  step("Test run", false, String(e && e.stack || e));
  try { await device.screenshot({ path: `${OUT}/error.png` }); } catch (_) { /* ignore */ }
}

// Dark mode: start fresh with the phone in dark mode and take a picture.
try {
  adb(`shell am force-stop ${PKG}`);
  adb("shell cmd uimode night yes");
  await sleep(1500);
  adb(`shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${PKG}/.MainActivity`);
  await sleep(6000);
  await device.screenshot({ path: `${OUT}/5-home-dark.png` });
  adb("shell cmd uimode night no");
} catch (e) {
  step("Dark mode picture", false, String(e && e.message || e));
}

writeFileSync(`${OUT}/logcat.txt`, adb("logcat -d -v time Capacitor:V Capacitor/Console:V Tesseract:V chromium:W AndroidRuntime:E *:S"));
report.finished = new Date().toISOString();
report.passed = report.steps.filter((s) => s.ok).length;
report.failed = report.steps.filter((s) => !s.ok).length;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed`);
try { await device.close(); } catch (_) { /* ignore */ }
process.exit(0);
