package io.github.purpleninjaradish.fluid;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Log;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Fluid for Android: fluency reading practice. A student reads a passage out loud; Fluid listens with Android's
 * on-device recognizer (the voice never leaves the device, nothing is recorded), helps with missed words and shows words
 * correct per minute.
 *
 * The page is Fluid's own, built into the app (assets/web, made by web/build.py) and served by the app over https, so it
 * never comes from the internet. FluidBridge gives it Android's speech recognizer and voice, and calls an AI the teacher
 * chooses, to write new passages. Nothing about readers is kept: the page keeps only passages added and which AI to use.
 */
public class MainActivity extends Activity {
    static final String TAG = "Fluid";
    private static final int REQ_MIC = 1;
    static final String PAGE = "https://" + WebViewAssetLoader.DEFAULT_DOMAIN + "/assets/web/index.html";
    static final String PAGE_ORIGIN = "https://" + WebViewAssetLoader.DEFAULT_DOMAIN;
    private static final int BG = 0xFFF2F5F8;

    private FrameLayout root;
    private WebView web;
    private FluidBridge bridge;
    private WebViewAssetLoader assets;
    private boolean onScreen, testRan;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 35) {
            // Android 15 draws apps under the status and navigation bars: keep Fluid clear of them and of the keyboard.
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets s = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(s.left, s.top, s.right, s.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        makeWeb();
        web.loadUrl(PAGE);
    }

    private void makeWeb() {
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);   // only the passages added here and which AI to use: never anything about a reader
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setGeolocationEnabled(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSafeBrowsingEnabled(true);
        s.setUserAgentString(s.getUserAgentString() + " FluidAndroid/" + BuildConfig.VERSION_NAME);
        assets = new WebViewAssetLoader.Builder().addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        bridge = new FluidBridge(this, web);
        if (!bridge.attach(PAGE_ORIGIN)) Log.w(TAG, "This WebView can't add the bridge; only the sample reading works.");
    }

    private final class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
            WebResourceResponse res = assets.shouldInterceptRequest(r.getUrl());
            if (res != null) return res;
            // The page never loads anything from the internet: an AI is reached only through FluidBridge.
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            Uri u = r.getUrl();
            if (u.toString().startsWith(PAGE_ORIGIN + "/")) return false;
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            if (scheme.equals("https") || scheme.equals("http") || scheme.equals("mailto")) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "Nothing can open " + scheme);
                }
            }
            return true;   // other addresses open in the browser, never inside the app
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            if (!BuildConfig.DEBUG || testRan) return;
            String js64 = getIntent().getStringExtra("fluid_js64");   // the emulator check only (base64, so adb's shell leaves it whole)
            if (js64 != null) {
                testRan = true;
                web.evaluateJavascript(new String(Base64.decode(js64, Base64.DEFAULT), StandardCharsets.UTF_8), null);
            }
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest r) {
            r.deny();   // the page hears the reader only through FluidBridge (Android's on-device recognizer)
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            if (BuildConfig.DEBUG) Log.i("FluidPage", m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            return true;
        }
    }

    // ---------- the microphone (asked for the first time the page listens) ----------
    boolean onScreen() {
        return onScreen;
    }

    boolean segmented() {
        return false;   // as in Odin: Android's plain (not segmented) sessions, restarted after each pause
    }

    boolean hasMic() {
        return checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    void askMic() {
        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        boolean yes = res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED;
        if (req == REQ_MIC && bridge != null) bridge.micAnswer(yes);
    }

    // ---------- the screen and the back button ----------
    @Override
    protected void onStart() {
        super.onStart();
        onScreen = true;
        if (web != null) web.onResume();
        if (bridge != null) bridge.appShown(true);
    }

    @Override
    protected void onStop() {
        onScreen = false;
        if (bridge != null) bridge.appShown(false);   // the microphone and the voice stop when Fluid leaves the screen
        if (web != null) web.onPause();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.destroy();
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        // While a reading is on the screen, the page says "stay" (and asks whether to stop).
        web.evaluateJavascript("(function(){try{return window.__fluidBack?window.__fluidBack():''}catch(e){return ''}})()", r -> {
            if ("\"stay\"".equals(r) || web == null) return;
            finish();
        });
    }
}
