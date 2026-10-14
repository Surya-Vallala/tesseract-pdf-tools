package co.tesseractstudio.pdftools;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The few things the web app can't do by itself inside an Android app:
 * - receive PDFs and photos from "Open with" and the Share menu ("incoming" event)
 * - save finished files into the phone's Downloads folder (saveToDownloads)
 * - check for a newer version and install it, only when the person asks (fetchText, installUpdate)
 * - scan paper with Google's document scanner (scanDocument)
 * Sharing out uses Capacitor's Share plugin; files are written with the Filesystem plugin.
 */
@CapacitorPlugin(name = "Tesseract")
public class TesseractPlugin extends Plugin {

    private static final String TAG = "Tesseract";
    private static final String INCOMING_DIR = "incoming";
    private static final String OUTGOING_DIR = "tpt-out";
    private static final String HANDLED_ACTION = "co.tesseractstudio.pdftools.HANDLED";
    // Updates only ever come from the app's own GitHub site.
    private static final String UPDATE_ROOT = "https://surya-vallala.github.io/tesseract-pdf-tools/";

    private ActivityResultLauncher<IntentSenderRequest> scanLauncher;
    private PluginCall scanCall;

    @Override
    public void load() {
        scanLauncher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), this::onScanResult);
        // Files from an earlier session are no longer needed.
        deleteTree(new File(getContext().getCacheDir(), INCOMING_DIR));
        deleteTree(new File(getContext().getCacheDir(), OUTGOING_DIR));
        deleteTree(new File(getContext().getCacheDir(), "updates"));
        deleteTree(new File(getContext().getCacheDir(), "scans"));
    }

    /* ---------- files arriving from other apps ---------- */

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null || HANDLED_ACTION.equals(action)) return;

        final List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action)) {
            if (intent.getData() != null) uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (list != null) {
                for (Uri u : list) if (u != null) uris.add(u);
            }
        } else {
            return;
        }
        if (uris.isEmpty() && intent.getClipData() != null) {
            ClipData clip = intent.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        }
        // Don't open the same file again if Android hands this intent back later.
        intent.setAction(HANDLED_ACTION);

        final String intentType = intent.getType();
        new Thread(() -> deliverIncoming(uris, intentType), "tpt-incoming").start();
    }

    private void deliverIncoming(List<Uri> uris, String intentType) {
        JSObject event = new JSObject();
        JSArray files = new JSArray();
        boolean failed = false;
        File batch = new File(new File(getContext().getCacheDir(), INCOMING_DIR), String.valueOf(System.currentTimeMillis()));
        //noinspection ResultOfMethodCallIgnored
        batch.mkdirs();
        Set<String> used = new HashSet<>();
        ContentResolver resolver = getContext().getContentResolver();
        for (Uri uri : uris) {
            try {
                String mime = null;
                try {
                    mime = resolver.getType(uri);
                } catch (Exception ignored) {}
                String name = cleanName(displayName(uri), mime != null ? mime : intentType);
                if (mime == null || mime.equals("application/octet-stream")) mime = guessMime(name, intentType);
                String unique = name;
                for (int n = 2; used.contains(unique.toLowerCase(Locale.ROOT)); n++) unique = withSuffix(name, n);
                used.add(unique.toLowerCase(Locale.ROOT));
                File out = new File(batch, unique);
                long size;
                try (InputStream in = resolver.openInputStream(uri)) {
                    if (in == null) throw new IOException("No data");
                    size = copy(in, new FileOutputStream(out));
                }
                JSObject f = new JSObject();
                f.put("path", out.getAbsolutePath());
                f.put("name", unique);
                f.put("type", mime);
                f.put("size", size);
                files.put(f);
            } catch (Exception e) {
                Logger.error(TAG, "Couldn't read an incoming file", e);
                failed = true;
            }
        }
        event.put("files", files);
        event.put("error", failed && files.length() == 0);
        event.put("partial", failed && files.length() > 0);
        notifyListeners("incoming", event, true);
    }

    /* ---------- files going out (written in pieces from the web app) ---------- */

    @PluginMethod
    public void writeChunk(PluginCall call) {
        String id = call.getString("id", "");
        if (id == null || !id.matches("[A-Za-z0-9_-]{6,40}")) {
            call.reject("Bad file id.");
            return;
        }
        String name = cleanName(call.getString("name"), call.getString("mime"));
        String data = call.getString("data", "");
        boolean append = Boolean.TRUE.equals(call.getBoolean("append", false));
        File dir = new File(new File(getContext().getCacheDir(), OUTGOING_DIR), id);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File out = new File(dir, name);
        try (FileOutputStream os = new FileOutputStream(out, append)) {
            if (data != null && !data.isEmpty()) os.write(android.util.Base64.decode(data, android.util.Base64.DEFAULT));
        } catch (Exception e) {
            Logger.error(TAG, "Writing a file failed", e);
            call.reject("The file couldn't be written.");
            return;
        }
        JSObject r = new JSObject();
        r.put("path", out.getAbsolutePath());
        r.put("name", name);
        call.resolve(r);
    }

    /* ---------- saving into Downloads ---------- */

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        File src = cacheFile(call.getString("path"));
        if (src == null) {
            call.reject("That file isn't available.");
            return;
        }
        String mime = call.getString("mime", "application/octet-stream");
        String name = cleanName(call.getString("name", src.getName()), mime);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContext().getContentResolver();
            Uri item = null;
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (item == null) throw new IOException("Downloads isn't available");
                try (OutputStream os = resolver.openOutputStream(item)) {
                    if (os == null) throw new IOException("Downloads isn't writable");
                    copy(new FileInputStream(src), os);
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(item, done, null, null);
                JSObject result = new JSObject();
                String saved = displayName(item);
                result.put("name", saved != null ? saved : name);
                result.put("folder", "Downloads");
                call.resolve(result);
            } catch (Exception e) {
                Logger.error(TAG, "Saving to Downloads failed", e);
                if (item != null) {
                    try {
                        resolver.delete(item, null, null);
                    } catch (Exception ignored) {}
                }
                call.reject("The file couldn't be saved to Downloads.");
            }
            return;
        }

        // Android 9 and older: let the person pick where it goes.
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "createDocumentResult");
    }

    @ActivityCallback
    private void createDocumentResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri target = result.getData() != null ? result.getData().getData() : null;
        if (result.getResultCode() != Activity.RESULT_OK || target == null) {
            call.reject("cancelled", "CANCELLED");
            return;
        }
        File src = cacheFile(call.getString("path"));
        if (src == null) {
            call.reject("That file isn't available.");
            return;
        }
        try (OutputStream os = getContext().getContentResolver().openOutputStream(target)) {
            if (os == null) throw new IOException("Not writable");
            copy(new FileInputStream(src), os);
            JSObject r = new JSObject();
            String saved = displayName(target);
            r.put("name", saved != null ? saved : call.getString("name"));
            r.put("folder", "");
            call.resolve(r);
        } catch (Exception e) {
            Logger.error(TAG, "Saving failed", e);
            call.reject("The file couldn't be saved.");
        }
    }

    /* ---------- updates (only when the person taps Check for updates) ---------- */

    @PluginMethod
    public void fetchText(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !url.startsWith(UPDATE_ROOT)) {
            call.reject("Not allowed.");
            return;
        }
        HttpURLConnection c = null;
        try {
            c = open(url);
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            byte[] buf = new byte[8192];
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > 262144) throw new IOException("Too large");
                }
            }
            JSObject r = new JSObject();
            r.put("text", new String(out.toByteArray(), StandardCharsets.UTF_8));
            call.resolve(r);
        } catch (Exception e) {
            Logger.error(TAG, "Update check failed", e);
            call.reject("Couldn't reach the update server.", "OFFLINE");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        String url = call.getString("url", "");
        String sha = call.getString("sha256", "");
        if (url == null || !url.startsWith(UPDATE_ROOT) || sha == null || !sha.matches("[0-9a-fA-F]{64}")) {
            call.reject("Not allowed.");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            // Android asks once: allow Tesseract PDF to install its own updates.
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            startActivityForResult(call, i, "installPermissionResult");
            return;
        }
        new Thread(() -> downloadAndInstall(call), "tpt-update").start();
    }

    @ActivityCallback
    private void installPermissionResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            call.reject("Permission to install updates wasn't given.", "NO_PERMISSION");
            return;
        }
        new Thread(() -> downloadAndInstall(call), "tpt-update").start();
    }

    private void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        String expected = call.getString("sha256", "").toLowerCase(Locale.ROOT);
        File dir = new File(getContext().getCacheDir(), "updates");
        deleteTree(dir);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File apk = new File(dir, "update.apk");
        HttpURLConnection c = null;
        try {
            c = open(url);
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            long total = c.getContentLengthLong();
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long done = 0;
            long lastReport = 0;
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    md.update(buf, 0, n);
                    done += n;
                    if (done - lastReport > 262144) {
                        lastReport = done;
                        JSObject p = new JSObject();
                        p.put("done", done);
                        p.put("total", total);
                        notifyListeners("updateProgress", p);
                    }
                }
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
            if (!hex.toString().equals(expected)) {
                deleteTree(dir);
                call.reject("The download was damaged.", "BAD_FILE");
                return;
            }
        } catch (Exception e) {
            Logger.error(TAG, "Update download failed", e);
            deleteTree(dir);
            call.reject("The update couldn't be downloaded.", "OFFLINE");
            return;
        } finally {
            if (c != null) c.disconnect();
        }

        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(uri, "application/vnd.android.package-archive");
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        getBridge().executeOnMainThread(() -> {
            try {
                getActivity().startActivity(install);
                call.resolve();
            } catch (Exception e) {
                Logger.error(TAG, "Couldn't open the installer", e);
                call.reject("Android's installer didn't open.");
            }
        });
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("Cache-Control", "no-cache");
        return c;
    }

    /* ---------- scanning with Google's document scanner ---------- */

    @PluginMethod
    public void scanDocument(PluginCall call) {
        if (scanCall != null) {
            call.reject("The scanner is already open.");
            return;
        }
        int limit = Math.max(1, Math.min(100, call.getInt("pageLimit", 60)));
        GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
            .setGalleryImportAllowed(true)
            .setPageLimit(limit)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .build();
        scanCall = call;
        getBridge().executeOnMainThread(() -> {
            try {
                GmsDocumentScanning.getClient(options)
                    .getStartScanIntent(getActivity())
                    .addOnSuccessListener((sender) -> scanLauncher.launch(new IntentSenderRequest.Builder(sender).build()))
                    .addOnFailureListener((e) -> {
                        Logger.error(TAG, "Google's scanner isn't available", e);
                        PluginCall c = scanCall;
                        scanCall = null;
                        if (c != null) c.reject("Google's scanner isn't available on this phone.", "UNAVAILABLE");
                    });
            } catch (Exception e) {
                Logger.error(TAG, "Google's scanner couldn't start", e);
                PluginCall c = scanCall;
                scanCall = null;
                if (c != null) c.reject("Google's scanner isn't available on this phone.", "UNAVAILABLE");
            }
        });
    }

    private void onScanResult(ActivityResult result) {
        final PluginCall call = scanCall;
        scanCall = null;
        if (call == null) return;
        GmsDocumentScanningResult res = null;
        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            res = GmsDocumentScanningResult.fromActivityResultIntent(result.getData());
        }
        if (res == null || res.getPages() == null || res.getPages().isEmpty()) {
            call.reject("cancelled", "CANCELLED");
            return;
        }
        final List<Uri> uris = new ArrayList<>();
        for (GmsDocumentScanningResult.Page p : res.getPages()) uris.add(p.getImageUri());
        new Thread(() -> {
            File dir = new File(new File(getContext().getCacheDir(), "scans"), String.valueOf(System.currentTimeMillis()));
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            JSArray files = new JSArray();
            try {
                for (int i = 0; i < uris.size(); i++) {
                    String name = "Scan page " + (i + 1) + ".jpg";
                    File out = new File(dir, name);
                    try (InputStream in = getContext().getContentResolver().openInputStream(uris.get(i))) {
                        if (in == null) throw new IOException("No data");
                        copy(in, new FileOutputStream(out));
                    }
                    JSObject f = new JSObject();
                    f.put("path", out.getAbsolutePath());
                    f.put("name", name);
                    f.put("type", "image/jpeg");
                    files.put(f);
                }
                JSObject r = new JSObject();
                r.put("files", files);
                call.resolve(r);
            } catch (Exception e) {
                Logger.error(TAG, "Couldn't read the scanned pages", e);
                call.reject("The scanned pages couldn't be read.");
            }
        }, "tpt-scan").start();
    }

    /* ---------- helpers ---------- */

    /** Only files inside the app's own cache can be saved or shared. */
    private File cacheFile(String path) {
        if (path == null) return null;
        try {
            if (path.startsWith("file:")) path = Uri.parse(path).getPath();
            if (path == null) return null;
            File f = new File(path).getCanonicalFile();
            String root = getContext().getCacheDir().getCanonicalPath() + File.separator;
            if (!f.getPath().startsWith(root) || !f.isFile()) return null;
            return f;
        } catch (IOException e) {
            return null;
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0) name = c.getString(i);
            }
        } catch (Exception ignored) {}
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        return name;
    }

    private static String cleanName(String name, String mime) {
        if (name == null) name = "";
        name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) name = "Shared file";
        String ext = extension(name);
        if (ext.isEmpty() && mime != null) {
            String guessed = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            if (guessed != null) name = name + "." + guessed;
        }
        if (name.length() > 120) {
            ext = extension(name);
            name = name.substring(0, 120 - ext.length() - 1) + "." + ext;
        }
        return name;
    }

    private static String guessMime(String name, String fallback) {
        String ext = extension(name).toLowerCase(Locale.ROOT);
        String m = ext.isEmpty() ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (m != null) return m;
        if (fallback != null && !fallback.contains("*")) return fallback;
        return "application/octet-stream";
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 && dot < name.length() - 1 ? name.substring(dot + 1) : "";
    }

    private static String withSuffix(String name, int n) {
        String ext = extension(name);
        String base = ext.isEmpty() ? name : name.substring(0, name.length() - ext.length() - 1);
        return base + " (" + n + ")" + (ext.isEmpty() ? "" : "." + ext);
    }

    private static long copy(InputStream in, OutputStream out) throws IOException {
        long total = 0;
        try (InputStream i = in; OutputStream o = out) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = i.read(buf)) > 0) {
                o.write(buf, 0, n);
                total += n;
            }
        }
        return total;
    }

    private static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
