#!/usr/bin/env bash
# Fluid's emulator check, run by .github/workflows/android.yml inside an Android 14 emulator, from the repository's top
# folder. It uses the debug build, which may reach a stand-in AI over plain http on the build machine (10.0.2.2 from the
# emulator). The page reports what it sees as "FLUID-REPORT" lines in Android's log. No student information is involved.
set -u
OUT=out
mkdir -p "$OUT"
PKG=io.github.purpleninjaradish.fluid.debug
ACT=$PKG/io.github.purpleninjaradish.fluid.MainActivity
python3 web/tests/fake_ai.py 8097 > "$OUT/fake-ai.log" 2>&1 &
sleep 2
adb install -r -g android/app/build/outputs/apk/debug/app-debug.apk 2>&1 | tee "$OUT/install.txt"
adb logcat -c
shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
js() { printf '%s' "$1" | base64 -w0; }
REPORT="const rep = (k, v) => console.log('FLUID-REPORT ' + k + ' ' + JSON.stringify(v));"
# Android can stop the app in an emulator's first minutes (Google Play services restarting): a step whose report is
# missing runs once more.
reported() { adb logcat -d -s FluidPage:I | grep -q "FLUID-REPORT $1 "; }

# 1. Fluid opens with its page, the bridge, Android's answer about on-device speech, and the device's voice. Then a sample
#    reading from start to finish, a passage written by the stand-in AI through the app, and one listening session.
main_step() {
  adb shell am force-stop "$PKG"
  adb shell am start -W -n "$ACT" --es fluid_js64 "$(js "$REPORT window.__fluidSimSpeed = 6; window.__fluidQuiet = true;
    setTimeout(async () => {
      rep('hello', Object.assign(window.__fluid.state(), { bridge: !!window.FluidAndroid, shim: !!window.ODIN_ANDROID, info: await window.ODIN_ANDROID.info }));
      const t0 = Date.now(); while (window.__fluid.state().speech === 'checking' && Date.now() - t0 < 20000) await new Promise(r => setTimeout(r, 300));
      rep('speech', { status: window.__fluid.state().speech, why: (window.SpeechRecognition || {}).why || '' });
      // the device's voice, through the app
      const said = await new Promise(res => { const u = new SpeechSynthesisUtterance('Hello, reader.'); const out = []; u.onstart = () => out.push('start'); u.onend = () => { out.push('end'); res(out); }; u.onerror = e => { out.push('error:' + e.error); res(out); }; window.__fluidQuiet = false; speechSynthesis.speak(u); setTimeout(() => res(out.concat(['timeout'])), 12000); });
      window.__fluidQuiet = true; rep('voice', said);
      // a sample reading
      document.querySelector('[data-a=level][data-v=\"0\"]').click(); document.querySelector('.pitem').click(); document.querySelector('[data-a=sample]').click();
      document.querySelector('#fl [data-flx=go]').click();
      const t1 = Date.now(); while (!(window.__fluid.state().reading && window.__fluid.state().reading.step === 'done') && Date.now() - t1 < 60000) await new Promise(r => setTimeout(r, 300));
      const res = window.__fluid.result(); rep('sample', { step: (window.__fluid.state().reading || {}).step, finished: res && res.finished, wcpm: res && res.wcpm, acc: res && res.acc });
      document.querySelector('#fl [data-flx=leave]').click();
      // a passage written by the stand-in AI, called by the app
      const det = document.querySelector('#ai-details'); det.open = true;
      const sel = document.querySelector('#ai-provider'); sel.value = 'custom'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      document.querySelector('#ai-url').value = 'http://10.0.2.2:8097/v1'; document.querySelector('#ai-model').value = 'stand-in';
      document.querySelector('[data-a=aisave]').click(); await new Promise(r => setTimeout(r, 300));
      document.querySelector('#fln-topic').value = 'a garden'; document.querySelector('#fln-topic').dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-a=write]').click();
      const t2 = Date.now(); while (!document.querySelector('#fln-text') && !document.querySelector('#fl-added .notice') && Date.now() - t2 < 30000) await new Promise(r => setTimeout(r, 300));
      const ta = document.querySelector('#fln-text'), err = document.querySelector('#fl-added .notice');
      rep('ai', { words: ta ? ta.value.split(/\\s+/).filter(Boolean).length : 0, error: err ? err.textContent : '' });
      // one listening session, straight to Android's recognizer: whatever it says, it says it cleanly
      const ev = await new Promise(resolve => { const out = []; const r = new SpeechRecognition(); r.processLocally = true; r.continuous = true; r.interimResults = true;
        r.onstart = () => out.push('start'); r.onerror = e => out.push('error:' + e.error); r.onend = () => { out.push('end'); resolve(out); };
        try { r.start(); } catch (e) { out.push('throw'); resolve(out); } setTimeout(() => { try { r.stop(); } catch (e) {} }, 4000); setTimeout(() => resolve(out.concat(['timeout'])), 12000); });
      rep('listen', ev);
    }, 2500);")"
  sleep 8; shot home
  sleep 30; shot sample
  sleep 30; shot after
}
main_step
if ! reported listen; then echo "main step: the app was stopped; again" | tee -a "$OUT/retry.txt"; main_step; fi
# 2. The back button on Fluid's first screen closes it.
adb shell input keyevent KEYCODE_BACK; sleep 2
adb shell dumpsys activity activities | grep -c "$PKG/" > "$OUT/after-back.txt" || true
adb logcat -d -v time | grep -E "FluidBridge|FluidPage|AndroidRuntime|FATAL|purpleninjaradish" > "$OUT/logcat.txt" || true
adb logcat -d -s FluidPage:I | grep -o "FLUID-REPORT.*" > "$OUT/report.txt" || true
adb logcat -d -b crash > "$OUT/crash.txt" 2>/dev/null || true
python3 android/ci/check.py "$OUT"
