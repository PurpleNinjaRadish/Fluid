package io.github.purpleninjaradish.fluid;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.ModelDownloadListener;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Log;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The bridge between Fluid's page and Android, shown to the page as window.FluidAndroid, and only on Fluid's own page
 * (built into the app, never inside a frame). Odin's android.js (odin/android.js) on the page side turns it into the
 * browser's SpeechRecognition and speechSynthesis, so the reading code works the same in Chrome and in the app.
 * This is Odin's OdinBridge (Odin 0.10.0, android/.../OdinBridge.java), with Fluid's names and one more message, "ai".
 *
 * Speech recognition uses ONLY Android's on-device recognizer (SpeechRecognizer.createOnDeviceSpeechRecognizer):
 * the student's voice never leaves the device and no audio is kept. If the device has no on-device recognizer,
 * the microphone is never turned on. The microphone also stops whenever Fluid leaves the screen.
 *
 * Messages are JSON. Page to app: hello, status, install, listen, stop, abort, say, hush, and ai {url, headers, body}: one
 * request to the AI the teacher chose, over HTTPS only, with only the headers an AI service needs (answered as "fluid").
 * App to page: reply (to hello, status, install), rec (start, partial, final, level, speechstart, speechend, error, end), say (start, end, error),
 * app (shown, hidden). "level" is how loud the microphone hears the room (Android's rmsdB, a few times a second), so the page can tell
 * that a student is reading even before Android has words for it. No sound is kept or sent anywhere else.
 */
final class FluidBridge implements WebViewCompat.WebMessageListener {
    private static final String TAG = "FluidBridge";
    private static final String NAME = "FluidAndroid";
    private static final String UNSTABLE = "android.speech.extra.UNSTABLE_TEXT";

    interface Done<T> {
        void done(T value);
    }

    private final MainActivity act;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newSingleThreadExecutor();   // the AI: a model can take a minute or two
    private static final Set<String> AI_HEADERS = new HashSet<>(Arrays.asList("content-type", "authorization", "x-api-key", "anthropic-version", "x-goog-api-key"));
    private JavaScriptReplyProxy reply;
    private boolean attached;
    private Listen cur;
    /**
     * 0.8.2: one on-device recognizer, kept between listening sessions. Making a new one each time binds to Android's speech
     * service again, which can take a second or two, and a student who starts reading at once would lose their first words.
     * It is let go when something goes wrong, when Fluid leaves the screen, and when the app closes.
     */
    private SpeechRecognizer shared;

    private SpeechRecognizer recognizer() {
        if (shared == null) shared = SpeechRecognizer.createOnDeviceSpeechRecognizer(act);
        return shared;
    }

    private void dropRecognizer() {
        final SpeechRecognizer s = shared;
        shared = null;
        if (s == null) return;
        try {
            s.cancel();
        } catch (RuntimeException e) {
            Log.w(TAG, "cancel", e);
        }
        main.post(() -> destroy(s));
    }
    private JSONObject waitingForMic;
    private TextToSpeech tts;
    private int ttsState;   // 0 starting, 1 ready, -1 none
    private final ArrayList<JSONObject> ttsWaiting = new ArrayList<>();

    FluidBridge(MainActivity act, WebView web) {
        this.act = act;
        this.web = web;
        tts = new TextToSpeech(act.getApplicationContext(), this::ttsReady);
    }

    /** Offers the bridge to pages from this origin only. */
    boolean attach(String origin) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false;
        try {
            if (attached) WebViewCompat.removeWebMessageListener(web, NAME);
            WebViewCompat.addWebMessageListener(web, NAME, Collections.singleton(origin), this);
            attached = true;
            return true;
        } catch (RuntimeException e) {
            Log.w(TAG, "No bridge for " + origin, e);
            attached = false;
            return false;
        }
    }

    @Override
    public void onPostMessage(WebView view, WebMessageCompat message, Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy replyProxy) {
        if (!isMainFrame) return;   // only Fluid's own page, never a frame inside it
        String data = message.getData();
        if (data == null) return;
        final JSONObject m;
        try {
            m = new JSONObject(data);
        } catch (JSONException e) {
            return;
        }
        reply = replyProxy;
        if (Looper.myLooper() == Looper.getMainLooper()) handle(m);
        else main.post(() -> handle(m));
    }

    private void handle(JSONObject m) {
        try {
            handle1(m);
        } catch (RuntimeException e) {
            // Android's speech services differ from device to device: whatever they throw, Fluid keeps running and says so.
            Log.e(TAG, "Bridge message " + m.optString("t") + " failed", e);
            String id = m.optString("id");
            String what = e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage());
            send(o("t", "reply", "id", id, "ok", false, "state", "unavailable", "why", "crash " + what,
                    "note", "Android's speech service stopped with an error (" + what + "). " + BY_HAND));
            if ("listen".equals(m.optString("t"))) {
                if (cur != null && cur.id.equals(id)) cur.fail("recognizer-error");
                else recError(id, "recognizer-error");
            }
        }
    }

    private void handle1(JSONObject m) {
        String id = m.optString("id");
        switch (m.optString("t")) {
            case "hello":
                send(o("t", "reply", "id", id, "app", BuildConfig.VERSION_NAME, "sdk", Build.VERSION.SDK_INT, "onDevice", onDevice(), "tts", ttsState));
                break;
            case "status":
                status(id, lang(m));
                break;
            case "install":
                install(id, lang(m));
                break;
            case "listen":
                listen(m);
                break;
            case "stop":
                if (cur != null && cur.id.equals(id)) cur.stop();
                break;
            case "abort":
                if (waitingForMic != null && id.equals(waitingForMic.optString("id"))) waitingForMic = null;
                if (cur != null && cur.id.equals(id)) cur.abort();
                break;
            case "say":
                say(m);
                break;
            case "hush":
                hush();
                break;
            case "ai": {
                final String url = m.optString("url", "");
                final JSONObject hs = m.optJSONObject("headers");
                final String json = m.optString("body", "");
                Uri u = Uri.parse(url);
                boolean local = BuildConfig.DEBUG && "http".equals(u.getScheme()) && "10.0.2.2".equals(u.getHost());   // the emulator check's stand-in AI
                if ((!"https".equals(u.getScheme()) && !local) || u.getHost() == null || json.length() > 64000) {
                    send(o("t", "fluid", "id", id, "status", 0, "error", "The AI's address must start with https://."));
                    break;
                }
                net.execute(() -> {
                    JSONObject a = aiRequest(url, hs, json);
                    try {
                        a.put("t", "fluid");
                        a.put("id", id);
                    } catch (JSONException e) {
                        Log.w(TAG, "bad reply", e);
                    }
                    send(a);
                });
                break;
            }
            default:
                break;
        }
    }

    void send(JSONObject msg) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post(() -> send(msg));
            return;
        }
        if (reply == null) return;
        try {
            reply.postMessage(msg.toString());
        } catch (RuntimeException e) {
            Log.w(TAG, "The page didn't take a message", e);
        }
    }

    static JSONObject o(Object... kv) {
        JSONObject j = new JSONObject();
        try {
            for (int k = 0; k + 1 < kv.length; k += 2) j.put((String) kv[k], kv[k + 1]);
        } catch (JSONException e) {
            Log.w(TAG, "bad message", e);
        }
        return j;
    }

    private static String lang(JSONObject m) {
        String l = m.optString("lang", "en-US");
        return l.isEmpty() ? "en-US" : l;
    }

    private boolean onDevice() {
        return Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(act);
    }

    // ---------- can this device recognize speech on the device? ----------
    private void status(String id, String lang) {
        if (Build.VERSION.SDK_INT < 31) {
            send(o("t", "reply", "id", id, "state", "unavailable", "why", "android"));
        } else if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(act)) {
            send(o("t", "reply", "id", id, "state", "unavailable", "why", "service"));
        } else if (Build.VERSION.SDK_INT < 33) {
            send(o("t", "reply", "id", id, "state", "available", "why", "assumed"));   // Android 12 can't say; try it
        } else {
            Api33.check(act, main, intent(lang, false, null, false), r -> send(o("t", "reply", "id", id, "state", r[0], "why", r[1])));
        }
    }

    private void install(String id, String lang) {
        if (Build.VERSION.SDK_INT < 33 || !onDevice()) {
            send(o("t", "reply", "id", id, "ok", false, "note", Build.VERSION.SDK_INT < 33 && onDevice()
                    ? "On this Android version, Fluid can't get the English speech pack by itself. Open Android's Settings › System › Languages & input › On-device recognition (or Voice input › Offline speech recognition), add English (US), then press Check again."
                    : "This device can't recognize speech on the device itself."));
            return;
        }
        Api33.install(act, main, intent(lang, false, null, false), r -> {
            try {
                r.put("t", "reply");
                r.put("id", id);
            } catch (JSONException e) {
                Log.w(TAG, "bad reply", e);
            }
            send(r);
        });
    }

    /** Android 13 and newer: ask the recognizer about the English pack, and get it. */
    static final class Api33 {
        /** Answers { state, why }: why says how the state was decided (installed, pending, supported, silent, cannot-check, no-answer, error-N). */
        static void check(MainActivity act, Handler main, Intent it, Done<String[]> done) {
            final SpeechRecognizer sr;
            try {
                sr = SpeechRecognizer.createOnDeviceSpeechRecognizer(act);
            } catch (RuntimeException e) {
                done.done(new String[] { "unavailable", "no-recognizer" });
                return;
            }
            final boolean[] over = { false };
            final String lang = it.getStringExtra(RecognizerIntent.EXTRA_LANGUAGE);
            final Runnable late = () -> {
                if (over[0]) return;
                over[0] = true;
                destroy(sr);
                done.done(new String[] { "available", "no-answer" });   // no answer: try it, and Fluid reports any error
            };
            main.postDelayed(late, 5000);
            try {
            sr.checkRecognitionSupport(it, act.getMainExecutor(), new RecognitionSupportCallback() {
                @Override
                public void onSupportResult(RecognitionSupport s) {
                    if (over[0]) return;
                    over[0] = true;
                    main.removeCallbacks(late);
                    main.post(() -> destroy(sr));
                    done.done(stateFor(s, lang));
                }

                @Override
                public void onError(int e) {
                    if (over[0]) return;
                    over[0] = true;
                    main.removeCallbacks(late);
                    main.post(() -> destroy(sr));
                    done.done(e == SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT ? new String[] { "available", "cannot-check" } : new String[] { "unavailable", "error-" + e });
                }
            });
            } catch (RuntimeException e) {
                Log.w(TAG, "checkRecognitionSupport", e);
                if (!over[0]) {
                    over[0] = true;
                    main.removeCallbacks(late);
                    main.post(() -> destroy(sr));
                    done.done(new String[] { "available", "cannot-check " + e.getClass().getSimpleName() });
                }
            }
        }

        static String[] stateFor(RecognitionSupport s, String lang) {
            List<String> installed = s.getInstalledOnDeviceLanguages(), pending = s.getPendingOnDeviceLanguages(), supported = s.getSupportedOnDeviceLanguages();
            if (has(installed, lang)) return new String[] { "available", "installed" };
            if (has(pending, lang)) return new String[] { "downloading", "pending" };
            if (has(supported, lang)) return new String[] { "downloadable", "supported" };
            if (installed.isEmpty() && pending.isEmpty() && supported.isEmpty()) return new String[] { "available", "silent" };   // the service didn't say; try it
            return new String[] { "unavailable", "not-listed " + installed + " " + supported };
        }

        static void install(MainActivity act, Handler main, Intent it, Done<JSONObject> done) {
            final SpeechRecognizer sr;
            try {
                sr = SpeechRecognizer.createOnDeviceSpeechRecognizer(act);
            } catch (RuntimeException e) {
                done.done(o("ok", false, "note", "This device can't recognize speech on the device itself."));
                return;
            }
            if (Build.VERSION.SDK_INT >= 34) {
                try {
                    Api34.download(sr, act, main, it, done);
                    return;
                } catch (RuntimeException e) {
                    Log.w(TAG, "triggerModelDownload with a listener", e);
                }
            }
            try {
                sr.triggerModelDownload(it);
                main.postDelayed(() -> destroy(sr), 3000);
                done.done(o("ok", false, "state", "downloading", "note", "Android is getting the English speech pack. When it's ready, press Check again. " + BY_HAND));
            } catch (RuntimeException e) {
                Log.w(TAG, "triggerModelDownload", e);
                main.post(() -> destroy(sr));
                done.done(o("ok", false, "note", "Android couldn't get the English speech pack for Fluid (" + e.getClass().getSimpleName() + "). " + BY_HAND));
            }
        }
    }

    /** Where the English pack can be added by hand, when Android doesn't add it for Fluid. */
    static final String BY_HAND = "If a reading still says the pack is missing, open Android's Settings › System › Languages (or Languages & input) › On-device recognition, add English (US), then press Check again.";

    /** Android 14 and newer: get the English pack and hear how it went. Some recognizers never answer: after 90 seconds, Fluid stops waiting. */
    static final class Api34 {
        static void download(SpeechRecognizer sr, MainActivity act, Handler main, Intent it, Done<JSONObject> done) {
            final boolean[] over = { false };
            final Runnable[] late = { null };
            final Done<JSONObject> fin = r -> {
                if (over[0]) return;
                over[0] = true;
                if (late[0] != null) main.removeCallbacks(late[0]);
                main.post(() -> destroy(sr));
                done.done(r);
            };
            late[0] = () -> fin.done(o("ok", false, "state", "downloading", "note", "Android didn't say whether it is getting the English speech pack. It may still be downloading, or waiting for Wi-Fi. " + BY_HAND));
            main.postDelayed(late[0], 90000);
            try {
            sr.triggerModelDownload(it, act.getMainExecutor(), new ModelDownloadListener() {
                @Override
                public void onProgress(int percent) {
                }

                @Override
                public void onSuccess() {
                    fin.done(o("ok", true));
                }

                @Override
                public void onScheduled() {
                    fin.done(o("ok", false, "state", "downloading", "note", "Android will get the English speech pack soon. It may wait for Wi-Fi. Press Check again later."));
                }

                @Override
                public void onError(int e) {
                    fin.done(o("ok", false, "note", e == SpeechRecognizer.ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS
                            ? "Android started getting the English speech pack. Press Check again in a minute."
                            : "The speech pack did not download (Android error " + e + "). Check the internet connection and try again. " + BY_HAND));
                }
            });
            } catch (RuntimeException e) {
                over[0] = true;   // the caller tries another way, so this attempt says nothing more
                main.removeCallbacks(late[0]);
                throw e;
            }
        }
    }

    static boolean has(List<String> langs, String lang) {
        if (langs == null) return false;
        for (String x : langs) if (x != null && x.replace('_', '-').equalsIgnoreCase(lang)) return true;
        return false;
    }

    static void destroy(SpeechRecognizer sr) {
        try {
            sr.destroy();
        } catch (RuntimeException e) {
            Log.w(TAG, "destroy", e);
        }
    }

    private Intent intent(String lang, boolean partial, ArrayList<String> bias, boolean segmented) {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partial);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        i.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, act.getPackageName());
        if (Build.VERSION.SDK_INT >= 33) {
            i.putExtra(RecognizerIntent.EXTRA_HIDE_PARTIAL_TRAILING_PUNCTUATION, true);
            if (bias != null && !bias.isEmpty()) i.putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, bias);
            if (segmented) {
                i.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS);
                i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 120000);
            }
        }
        return i;
    }

    // ---------- listening ----------
    private void listen(JSONObject m) {
        String id = m.optString("id");
        if (cur != null) cur.abort();
        if (!onDevice()) {
            recError(id, "service-not-allowed");   // never a recognizer that could send the voice away
            return;
        }
        if (!act.onScreen()) {
            recError(id, "interrupted");
            return;
        }
        if (!act.hasMic()) {
            if (waitingForMic != null) recError(waitingForMic.optString("id"), "aborted");
            waitingForMic = m;
            act.askMic();
            return;
        }
        ArrayList<String> bias = new ArrayList<>();
        JSONArray b = m.optJSONArray("bias");
        if (b != null) {
            for (int k = 0; k < b.length() && k < 150; k++) {
                String w = b.optString(k, "");
                if (!w.isEmpty()) bias.add(w);
            }
        }
        cur = new Listen(id, lang(m), m.optBoolean("continuous"), m.optBoolean("interim"), bias, act.segmented());
        cur.begin();
    }

    void micAnswer(boolean ok) {
        JSONObject m = waitingForMic;
        waitingForMic = null;
        if (m == null) return;
        if (ok) listen(m);
        else recError(m.optString("id"), "not-allowed");
    }

    private void recError(String id, String err) {
        send(o("t", "rec", "id", id, "ev", "error", "error", err));
        send(o("t", "rec", "id", id, "ev", "end"));
    }

    void appShown(boolean shown) {
        send(o("t", "app", "ev", shown ? "shown" : "hidden"));
        if (!shown) stopAll("interrupted");
    }

    void stopAll(String why) {
        hush();
        if (waitingForMic != null) {
            recError(waitingForMic.optString("id"), why);
            waitingForMic = null;
        }
        if (cur != null) cur.fail(why);
        dropRecognizer();
    }

    /** One request to the AI the teacher chose: only the headers an AI service needs, and no cookies. */
    private JSONObject aiRequest(String url, JSONObject hs, String json) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(190000);
            c.setUseCaches(false);
            c.setRequestMethod("POST");
            c.setRequestProperty("User-Agent", "FluidAndroid/" + BuildConfig.VERSION_NAME);
            if (hs != null) {
                Iterator<String> it = hs.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if (AI_HEADERS.contains(k.toLowerCase(Locale.ROOT))) c.setRequestProperty(k, hs.optString(k, ""));
                }
            }
            byte[] out = json.getBytes(StandardCharsets.UTF_8);
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(out.length);
            try (OutputStream o = c.getOutputStream()) {
                o.write(out);
            }
            int status = c.getResponseCode();
            String body = "";
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null) {
                try (InputStream s = in) {
                    ByteArrayOutputStream buf = new ByteArrayOutputStream();
                    byte[] chunk = new byte[16384];
                    int n, total = 0;
                    while ((n = s.read(chunk)) > 0) {
                        total += n;
                        if (total > 2 * 1024 * 1024) throw new IOException("the AI's answer is too large");
                        buf.write(chunk, 0, n);
                    }
                    body = buf.toString("UTF-8");
                }
            }
            return o("status", status, "body", body);
        } catch (IOException | RuntimeException e) {
            return o("status", 0, "error", "Can't reach the AI (" + e.getClass().getSimpleName() + ").");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    void destroy() {
        net.shutdownNow();
        stopAll("aborted");
        if (tts != null) {
            tts.shutdown();
            tts = null;
        }
        ttsState = -1;
        if (attached && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            try {
                WebViewCompat.removeWebMessageListener(web, NAME);
            } catch (RuntimeException e) {
                Log.w(TAG, "remove", e);
            }
        }
        attached = false;
        reply = null;
    }

    /**
     * One listening session from the page. Like Chrome's continuous recognition: when Android ends an utterance
     * (the student paused), listening goes straight on, and the results keep counting up.
     */
    private final class Listen implements RecognitionListener {
        final String id, lang;
        final boolean continuous, interim, segmented;
        final ArrayList<String> bias;
        SpeechRecognizer sr;
        int index, retries;
        boolean live = true, stopping, started, broken;
        String partial = "";
        long levelAt;
        final long[] recent = new long[6];
        int recentAt;

        Listen(String id, String lang, boolean continuous, boolean interim, ArrayList<String> bias, boolean segmented) {
            this.id = id;
            this.lang = lang;
            this.continuous = continuous;
            this.interim = interim;
            this.bias = bias;
            this.segmented = segmented;
        }

        void begin() {
            if (Build.VERSION.SDK_INT < 31) {
                fail("service-not-allowed");
                return;
            }
            try {
                sr = recognizer();
                sr.setRecognitionListener(this);
            } catch (RuntimeException e) {
                sr = null;
                dropRecognizer();
                fail("service-not-allowed");
                return;
            }
            go();
        }

        private void go() {
            if (!live || sr == null) return;
            partial = "";
            try {
                sr.startListening(intent(lang, interim, bias, continuous && segmented));
            } catch (RuntimeException e) {
                fail("audio-capture");
            }
        }

        private void again(long delay) {
            long now = SystemClock.elapsedRealtime(), oldest = recent[recentAt];
            recent[recentAt] = now;
            recentAt = (recentAt + 1) % recent.length;
            if (oldest != 0 && now - oldest < 3000) delay = Math.max(delay, 400);   // many restarts in a row: slow down
            main.postDelayed(this::go, delay);
        }

        void stop() {
            if (!live) return;
            stopping = true;
            try {
                sr.stopListening();
            } catch (RuntimeException e) {
                end();
                return;
            }
            main.postDelayed(() -> {
                if (live) end();
            }, 2000);   // in case Android never answers
        }

        /** The page already counts this session as ended. */
        void abort() {
            if (!live) return;
            live = false;
            release();
        }

        void fail(String err) {
            if (!live) return;
            broken = true;   // after an error, the next session starts with a new recognizer
            send(o("t", "rec", "id", id, "ev", "error", "error", err));
            end();
        }

        void end() {
            if (!live) return;
            live = false;
            release();
            send(o("t", "rec", "id", id, "ev", "end"));
        }

        private void release() {
            if (cur == this) cur = null;
            final SpeechRecognizer s = sr;
            sr = null;
            if (s == null) return;
            if (broken || s != shared) {
                if (s == shared) dropRecognizer();
                else main.post(() -> destroy(s));
                return;
            }
            try {
                s.cancel();   // kept for the next session
            } catch (RuntimeException e) {
                Log.w(TAG, "cancel", e);
                dropRecognizer();
            }
        }

        private void heard(String text, boolean fin) {
            send(o("t", "rec", "id", id, "ev", fin ? "final" : "partial", "i", index, "text", text));
            if (fin) {
                index++;
                partial = "";
            }
        }

        private String best(Bundle b) {
            ArrayList<String> r = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            return r == null || r.isEmpty() || r.get(0) == null ? null : r.get(0).trim();
        }

        /**
         * A live result: Google's recognizer splits it into the words it is sure of (RESULTS_RECOGNITION) and the newest
         * words it may still change ("android.speech.extra.UNSTABLE_TEXT"). Both together are what the student has said so far.
         */
        private String liveText(Bundle b) {
            String sure = best(b);
            ArrayList<String> u = b == null ? null : b.getStringArrayList(UNSTABLE);
            String more = u == null || u.isEmpty() || u.get(0) == null ? "" : u.get(0).trim();
            if (sure == null || sure.isEmpty()) return more.isEmpty() ? null : more;
            return more.isEmpty() ? sure : sure + " " + more;
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            if (live && !started) {
                started = true;
                send(o("t", "rec", "id", id, "ev", "start"));
            }
        }

        @Override
        public void onBeginningOfSpeech() {
            retries = 0;
            if (live) send(o("t", "rec", "id", id, "ev", "speechstart"));
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            if (!live || Float.isNaN(rmsdB) || Float.isInfinite(rmsdB)) return;
            long now = SystemClock.elapsedRealtime();
            if (now - levelAt < 120) return;   // a few times a second is enough
            levelAt = now;
            send(o("t", "rec", "id", id, "ev", "level", "v", Math.round(rmsdB * 10) / 10.0));
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
            if (live) send(o("t", "rec", "id", id, "ev", "speechend"));
        }

        @Override
        public void onEvent(int type, Bundle params) {
        }

        @Override
        public void onPartialResults(Bundle b) {
            if (!live || !interim) return;
            String t = liveText(b);
            if (t == null || t.isEmpty() || t.equals(partial)) return;
            partial = t;
            heard(t, false);
        }

        @Override
        public void onSegmentResults(Bundle b) {
            if (!live) return;
            String t = best(b);
            if (t != null && !t.isEmpty()) heard(t, true);
            else if (!partial.isEmpty()) heard(partial, true);
        }

        @Override
        public void onEndOfSegmentedSession() {
            if (!live) return;
            if (continuous && !stopping) again(0);
            else end();
        }

        @Override
        public void onResults(Bundle b) {
            if (!live) return;
            String t = best(b);
            if (t != null && !t.isEmpty()) heard(t, true);
            else if (!partial.isEmpty()) heard(partial, true);   // keep what was heard if Android ends with nothing
            if (continuous && !stopping) again(0);
            else end();
        }

        @Override
        public void onError(int e) {
            if (!live) return;
            if (stopping) {
                if (!partial.isEmpty()) heard(partial, true);
                end();
                return;
            }
            switch (e) {
                case SpeechRecognizer.ERROR_NO_MATCH:
                case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                    if (!partial.isEmpty()) heard(partial, true);
                    if (continuous) again(0);   // silence doesn't end continuous listening
                    else fail("no-speech");
                    return;
                case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                case SpeechRecognizer.ERROR_CLIENT:
                    if (++retries <= 4) {
                        try {
                            sr.cancel();
                        } catch (RuntimeException x) {
                            Log.w(TAG, "cancel", x);
                        }
                        again(300);
                        return;
                    }
                    fail(e == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ? "busy" : "recognizer-" + e);
                    return;
                case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                    fail("not-allowed");
                    return;
                case SpeechRecognizer.ERROR_AUDIO:
                    fail("audio-capture");
                    return;
                case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
                case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                    fail("language-not-supported");
                    return;
                case SpeechRecognizer.ERROR_NETWORK:
                case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                case SpeechRecognizer.ERROR_SERVER:
                    fail("network");
                    return;
                case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS:
                    fail("busy");
                    return;
                default:
                    fail("recognizer-" + e);
            }
        }
    }

    // ---------- the device's voice ----------
    private void ttsReady(int status) {
        main.post(() -> {
            if (status != TextToSpeech.SUCCESS || tts == null) {
                ttsState = -1;
                for (JSONObject m : ttsWaiting) sayFailed(m.optString("id"));
                ttsWaiting.clear();
                return;
            }
            ttsState = 1;
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String u) {
                    send(o("t", "say", "id", u, "ev", "start"));
                }

                @Override
                public void onDone(String u) {
                    send(o("t", "say", "id", u, "ev", "end"));
                }

                @SuppressWarnings("deprecation")
                @Override
                public void onError(String u) {
                    send(o("t", "say", "id", u, "ev", "error"));
                }

                @Override
                public void onError(String u, int code) {
                    send(o("t", "say", "id", u, "ev", "error", "error", "tts-" + code));
                }

                @Override
                public void onStop(String u, boolean interrupted) {
                    send(o("t", "say", "id", u, "ev", "error", "error", "interrupted"));
                }
            });
            pickVoice();
            ArrayList<JSONObject> waiting = new ArrayList<>(ttsWaiting);
            ttsWaiting.clear();
            for (JSONObject m : waiting) say(m);
        });
    }

    /** An English voice that works without the internet, US English first. */
    private void pickVoice() {
        try {
            Voice best = null;
            int score = -1;
            Set<Voice> all = tts.getVoices();
            if (all != null) {
                for (Voice v : all) {
                    Locale l = v.getLocale();
                    if (l == null || !"en".equals(l.getLanguage()) || v.isNetworkConnectionRequired()) continue;
                    Set<String> f = v.getFeatures();
                    if (f != null && f.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                    int sc = ("US".equals(l.getCountry()) ? 8 : 0) + (v.getQuality() >= Voice.QUALITY_HIGH ? 2 : 0) + (v.getLatency() <= Voice.LATENCY_NORMAL ? 1 : 0);
                    if (sc > score) {
                        score = sc;
                        best = v;
                    }
                }
            }
            if (best != null) tts.setVoice(best);
            else tts.setLanguage(Locale.US);
        } catch (RuntimeException e) {
            Log.w(TAG, "voice", e);
        }
    }

    private void say(JSONObject m) {
        String id = m.optString("id");
        if (ttsState == 0) {
            ttsWaiting.add(m);
            return;
        }
        if (ttsState < 0 || tts == null) {
            sayFailed(id);
            return;
        }
        tts.setSpeechRate((float) Math.max(0.5, Math.min(2.0, m.optDouble("rate", 1))));
        tts.setPitch((float) Math.max(0.5, Math.min(2.0, m.optDouble("pitch", 1))));
        Bundle p = new Bundle();
        p.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id);
        if (tts.speak(m.optString("text"), TextToSpeech.QUEUE_ADD, p, id) != TextToSpeech.SUCCESS) sayFailed(id);
    }

    private void sayFailed(String id) {
        send(o("t", "say", "id", id, "ev", "error", "error", "synthesis-unavailable"));
    }

    private void hush() {
        ttsWaiting.clear();
        if (ttsState == 1 && tts != null) tts.stop();
    }
}
