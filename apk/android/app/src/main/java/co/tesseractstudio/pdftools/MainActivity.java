package co.tesseractstudio.pdftools;

import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(TesseractPlugin.class);
        super.onCreate(savedInstanceState);

        // If Android stops the page to free memory while another app is in front (the camera,
        // the scanner), start the page again instead of letting the whole app close.
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                runOnUiThread(() -> {
                    if (!isFinishing() && !isDestroyed()) recreate();
                });
                return true;
            }
        });

        // The phone's Back button walks back through the app's own screens (closing a sheet,
        // asking to save before closing a file) exactly as it does in Chrome. Only when there
        // is nothing left to go back to does Android take over and leave the app.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge != null ? bridge.getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
