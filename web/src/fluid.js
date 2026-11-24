// =====================================================================================================
// Fluid: fluency reading practice. A student reads a passage out loud; Fluid listens on the device (the voice never leaves
// it, nothing is recorded), says a word when the student is stuck or misreads it, has the student say it again, praises,
// and shows words correct per minute and accuracy. It stands alone: no sign-in, no server, and nothing about readers is
// kept: the readings of this session are in memory and go when Fluid closes.
// The reading screen is Odin's (Project Cerberus, page-src/src/ui_fluency.js, 0.10), adapted here; the passages, the
// scoring and the AI helpers are Odin's own files (odin/, copied by tools/sync_odin.py).
// =====================================================================================================
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const plural = (n, w, ws) => `${n} ${n === 1 ? w : ws || w + "s"}`;
  const DROID = (typeof window !== "undefined" && window.ODIN_ANDROID) || null;   // the Fluid app for Android (odin/android.js)
  const BR = window.FluidAndroid || null;
  const CAN_MIC = true;
  const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
  const pad = n => String(n).padStart(2, "0");
  const ISO_TODAY = (d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)(new Date());
  const APK = "https://github.com/PurpleNinjaRadish/Fluid/releases/latest/download/fluid-android.apk";
  // The page's own storage keeps only passages added here and which AI to use (never a key, never anything about a reader).
  const STORE = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- the Android app: Fluid's own messages (the speech messages are odin/android.js's) ----------
  let fSeq = 0;
  const fWaits = new Map();
  if (BR) {
    const prev = BR.onmessage;
    BR.onmessage = ev => {
      let m = null; try { m = JSON.parse(ev && ev.data); } catch (e) {}
      if (m && m.t === "fluid" && fWaits.has(m.id)) { const f = fWaits.get(m.id); fWaits.delete(m.id); f(m); return; }
      if (prev) prev(ev);
    };
  }
  const askApp = (t, extra, ms) => new Promise(res => {
    if (!BR) return res(null);
    const id = "f" + (++fSeq); fWaits.set(id, res);
    try { BR.postMessage(JSON.stringify(Object.assign({ t, id }, extra || {}))); } catch (e) { fWaits.delete(id); return res(null); }
    setTimeout(() => { if (fWaits.has(id)) { fWaits.delete(id); res(null); } }, ms || 15000);
  });

  // ---------- the state of this page: nothing about readers ----------
  const S = { level: null, open: null, notice: null, noticeKind: "", runs: [], best: {}, add: null, aiOpen: false, aiMsg: "", aiOk: null, aiBusy: false, confirmDel: null };
  const flTime = secs => { const s = Math.max(0, Math.round(secs)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const flLevel = b => (b === 0 ? "Kindergarten level" : `Grade ${b} level`);
  const LEVEL_SHORT = b => (b === 0 ? "K" : String(b));
  const KIND = { practice: "Practice", minute: "One-minute reading" };
  // Passages added on this device (written with AI or typed in) join Odin's, as in Odin (A3-1 next to F3-1).
  const ADDED_KEY = "fluid.passages";
  flAddPassages(STORE.get(ADDED_KEY, []));
  const addedPassages = () => FL_PASSAGES.filter(p => p.added);
  const saveAdded = () => STORE.set(ADDED_KEY, addedPassages().map(p => ({ id: p.id, band: p.band, title: p.title, text: p.text, topic: p.topic, source: p.source })));
  // Words common enough that the recognizer needs no help with them: Dolch nouns, and words in many of the passages.
  let COMMON = null;
  function commonWords() {
    if (COMMON) return COMMON;
    const seen = new Map();
    FL_PASSAGES.filter(p => !p.added).forEach(p => new Set(flPassageWords(p.id).map(w => w.n)).forEach(n => seen.set(n, (seen.get(n) || 0) + 1)));
    COMMON = new Set([...FL_DOLCH_NOUNS.split(" ").map(flNorm), ...FL_TINY, ...[...seen].filter(([, c]) => c >= 4).map(([n]) => n)]);
    return COMMON;
  }

  // ---------- can this device recognize speech on the device itself? ----------
  // Only the unprefixed SpeechRecognition with processLocally keeps speech on the device. Without it, Fluid never turns the microphone on.
  const FLS = { status: "checking", quality: "dictation", phrases: true, installing: false, why: "" };
  const flSR = () => (typeof window !== "undefined" && window.SpeechRecognition) || null;
  // Asking a browser that has no speech service can crash the tab (seen in plain Chromium), so Fluid asks on its own only in
  // Google Chrome and in the app; elsewhere the reader presses "Check this browser".
  const flIsChrome = () => { try { return !!(navigator.userAgentData && navigator.userAgentData.brands.some(b => b.brand === "Google Chrome")); } catch (e) { return false; } };
  async function flCheckSpeech(auto) {
    const set = s => { FLS.status = s; if (!FL.on) render(); };
    if (!CAN_MIC) return set("preview");
    if (!window.isSecureContext) return set("insecure");
    const SR = flSR();
    if (!SR || !("processLocally" in SR.prototype) || typeof SR.available !== "function") return set("none");
    if (auto && !flIsChrome() && !DROID) return set("manual");
    FLS.status = "checking";
    try {
      let r = await SR.available({ langs: ["en-US"], processLocally: true, quality: "dictation" });
      if (r === "unavailable") { const r2 = await SR.available({ langs: ["en-US"], processLocally: true }); if (r2 !== "unavailable") { FLS.quality = null; r = r2; } }
      FLS.why = String(SR.why || "");
      set(r === "available" || r === "downloadable" || r === "downloading" || r === "denied" ? r : "unavailable");
    } catch (e) { set("none"); }
  }
  async function flInstall() {
    const SR = flSR(); if (!SR || typeof SR.install !== "function") return;
    FLS.installing = true; FLS.status = "downloading"; render();
    try { const ok = await SR.install(Object.assign({ langs: ["en-US"], processLocally: true }, FLS.quality ? { quality: FLS.quality } : {})); say(ok ? `The English speech pack is installed. Speech is now recognized on this ${DROID ? "device" : "computer"}.` : (SR.note || "The speech pack did not install. Check the internet connection and try again."), ok ? "ok" : ""); }
    catch (e) { say("The speech pack did not install: " + (e.message || e), "bad"); }
    FLS.installing = false; await flCheckSpeech(); render();
  }
  const flReady = () => FLS.status === "available";
  const FL_STATUS = {
    checking: ["", "Checking whether this device can recognize speech…"],
    manual: ["mid", "Fluid uses the microphone in Google Chrome, which can recognize speech on the computer itself. Press <b>Check this browser</b> to see whether this one can."],
    preview: ["", "The microphone is off here. <b>Watch a sample reading</b> to see how it works."],
    insecure: ["no", "The microphone only works on a secure page: an <span class='mono'>https://</span> address. Until then, <b>Watch a sample reading</b>."],
    none: ["no", "This browser can't recognize speech on the device itself, so Fluid won't turn the microphone on. Use a current version of Google Chrome on a computer or Chromebook, or the Fluid app for Android."],
    unavailable: ["no", "This computer can't recognize English speech on the device. Try a current version of Google Chrome, or the Fluid app for Android."],
    downloadable: ["mid", "This computer needs Chrome's English speech pack, a one-time download. Nothing about readers is sent."],
    downloading: ["mid", "Downloading the English speech pack…"],
    available: ["ok", "Ready. Speech is recognized on this computer, so a reader's voice never leaves it. Nothing is recorded."],
    denied: ["no", "The microphone is blocked for this page. Allow it in the browser's site settings, then press <b>Check again</b>."]
  };
  // The same, in the Fluid app for Android, where Android's on-device recognizer does the listening.
  const FL_STATUS_APP = {
    checking: ["", "Checking whether this device can recognize speech…"],
    none: ["no", "This device can't recognize speech on the device itself, so Fluid won't turn the microphone on. The microphone needs Android 12 or newer with Google's speech services."],
    unavailable: ["no", "This device can't recognize English speech on the device itself, so Fluid won't turn the microphone on."],
    downloadable: ["mid", "This device needs Android's English speech pack, a one-time download. Nothing about readers is sent."],
    downloading: ["mid", "Android is getting the English speech pack. It may wait for Wi-Fi. Press <b>Check again</b> in a minute."],
    available: ["ok", "Ready. Android recognizes speech on this device, so a reader's voice never leaves it. Nothing is recorded."],
    denied: ["no", "Fluid isn't allowed to use the microphone. Press <b>Check again</b> and choose <b>Allow</b>. If Android doesn't ask, open Android's Settings › Apps › Fluid › Permissions › Microphone › Allow."]
  };
  const flStatusText = s => (DROID && FL_STATUS_APP[s]) || FL_STATUS[s] || FL_STATUS.none;
  // Chrome on Android phones can't keep speech on the device; the Fluid app can.
  const FL_ON_ANDROID = !DROID && typeof navigator !== "undefined" && /Android/.test(navigator.userAgent || "");

  // ---------- the voice: the device's built-in speech, preferring a voice that works offline ----------
  let FL_VOICE;
  function flVoice() {
    if (FL_VOICE) return FL_VOICE;
    try { const en = speechSynthesis.getVoices().filter(v => /^en([-_]|$)/i.test(v.lang)); FL_VOICE = en.find(v => v.localService && /US/i.test(v.lang)) || en.find(v => v.localService) || null; } catch (e) { FL_VOICE = null; }
    return FL_VOICE;
  }
  // Speak, then carry on. The microphone is stopped first so the voice is not heard as the student reading.
  function flSay(text, then, opts) {
    const o = opts || {}, gen = ++FL.sayGen;
    FL.speaking = true; flStopRec(true);
    FL.caption = text; flPaintCaption();
    let done = false;
    const fin = () => { if (done || gen !== FL.sayGen) return; done = true; FL.speaking = false; FL.caption = o.keep ? text : ""; flPaintCaption(); if (then) setTimeout(then, 250); };
    const est = 700 + text.split(/\s+/).length * 420;
    setTimeout(fin, est + 2500);   // if the device has no voice, or the end is never reported
    if (!canSpeak() || window.__fluidQuiet) { setTimeout(fin, window.__fluidQuiet ? 60 : est); return; }   // __fluidQuiet: the tests only
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text); u.lang = "en-US"; u.rate = o.rate || 0.92; const v = flVoice(); if (v) u.voice = v;
      u.onend = fin; u.onerror = fin; speechSynthesis.speak(u);
    } catch (e) { setTimeout(fin, est); }
  }
  const flPick = list => list[Math.floor(Math.random() * list.length)];
  const FL_CHEER = { praise: ["Yes! Great job!", "That's right! Nice work!", "You got it! Well done!", "Perfect! Great reading!", "Awesome! You said it right!", "Yes! I'm proud of you!"],
    half: ["Great reading. Keep going!", "You're halfway there!", "Nice and smooth. Keep it up!"] };

  // ---------- the recognizer: on the device only, or a pretend reader for the sample ----------
  function flMakeRec(handlers) {
    if (FL.mode === "sample") return flSimRec(handlers);
    const SR = flSR(), r = new SR();
    r.lang = "en-US"; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.processLocally = true;
    if (r.processLocally !== true) throw new Error("This browser would not promise to keep speech on the device, so the microphone stays off.");
    if (FLS.phrases && typeof SpeechRecognitionPhrase === "function" && "phrases" in r) {
      // Help with names and less common words only, so misread common words still show as misread.
      const common = commonWords();
      try { r.phrases = [...new Set(FL.words.map(w => w.n))].filter(w => w.length > 3 && !common.has(w)).slice(0, 120).map(w => new SpeechRecognitionPhrase(w, 2)); } catch (e) {}
    }
    r.onresult = e => { let txt = ""; for (let i = 0; i < e.results.length; i++) txt += " " + e.results[i][0].transcript; handlers.text(txt); };
    r.onerror = e => handlers.error(e.error || "error");
    r.onend = () => handlers.end();
    r.onstart = () => handlers.start && handlers.start();
    r.onsoundlevel = e => handlers.level && handlers.level(e.level);   // the app only: how loud the microphone hears the room
    r.start();
    return r;
  }
  // The sample reader: invented, reads a little slower than the goal, stops on one word, misreads one and fixes another.
  function flSimRec(h) {
    const P = FL.sim, timers = [];
    let said = [], live = true;
    const sayW = (w, ms, tag) => timers.push(setTimeout(() => { if (!live) return; if (tag) P.done.add(tag); said.push(w); h.text(said.join(" ")); }, ms));
    if (FL.listen === "check") sayW("i am ready to read", 900);
    else if (FL.listen === "repeat") sayW(FL.words[FL.helpAt].n, 900);
    else {
      let t = 600;
      for (let i = FL.ptr; i < FL.words.length; i++) {
        const w = FL.words[i].n, step = P.ms * (0.75 + Math.random() * 0.5) + (FL.words[i].first || /[.!?]”?$/.test(FL.words[i - 1] ? FL.words[i - 1].w : "") ? P.ms * 0.6 : 0);
        if (i === P.stop && !P.done.has("stop")) { timers.push(setTimeout(() => { if (live) P.done.add("stop"); }, t)); break; }
        t += step;
        if (i === P.wrong && !P.done.has("wrong")) { sayW(P.wrongWord, t, "wrong"); continue; }
        if (i === P.fix && !P.done.has("fix")) { sayW(P.fixWord, t, "fix"); t += P.ms * 1.2; sayW(w, t); continue; }
        sayW(w, t);
      }
    }
    if (h.start) setTimeout(() => { if (live) h.start(); }, 0);
    return { abort() { live = false; timers.forEach(clearTimeout); }, stop() { live = false; timers.forEach(clearTimeout); setTimeout(() => h.end(), 50); } };
  }
  function flSimPlan(words, wcpm) {
    const n = words.length, pick = (from, to) => { for (let i = from; i < Math.min(to, n - 2); i++) if (words[i].n.length >= 4) return i; return Math.min(from, n - 2); };
    const wrong = pick(Math.floor(n * 0.12), n), stop = pick(Math.floor(n * 0.3), n), fix = pick(Math.floor(n * 0.5), n);
    const twist = w => (w.length > 4 ? w.slice(0, -2) : w + "s");
    return { ms: 60000 / Math.max(25, wcpm) / (window.__fluidSimSpeed || 1), wrong, stop, fix, wrongWord: twist(words[wrong].n), fixWord: twist(words[fix].n), done: new Set() };
  }

  // ---------- one reading ----------
  const FL = { on: false, sayGen: 0, recGen: 0 };
  function flEl() { let el = document.getElementById("fl"); if (!el) { el = document.createElement("div"); el.id = "fl"; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", "Reading"); document.body.appendChild(el); } return el; }
  function flOpen(pid, kind, mode) {
    const p = FL_BY_ID[pid], words = flPassageWords(pid), B = S.best[pid] || {};
    FL.op = (FL.op || 0) + 1;   // timers left over from an earlier reading check this
    Object.assign(FL, { on: true, pid, kind, mode, passage: p, words, n: words.length, timed: kind === "minute", step: "hello",
      marks: new Array(words.length).fill(null), said: {}, helped: new Set(), seg: null, rec: null, ptr: 0, t0: 0, tLast: 0, tTok: 0, tBegin: 0,
      supplied: 0, inARow: 0, half: false, listen: null, helpAt: -1, caption: "", result: null, exitAsk: false, ended: false,
      best: kind === "practice" ? (B.wcpm != null ? B.wcpm : null) : null, fastest: kind === "practice" ? B.secs || null : null, err: null, checkTries: 0,
      vox: { n: 0, floor: 0, level: 0, at: 0, runStart: 0 }, awaitReady: false, readyAt: 0, listenAt: 0, settling: false, settleFin: null, stopFin: null, rep: null, busyTries: 0, fix: null });
    if (mode === "sample") { const g = flGoal(p.band, p.band, ISO_TODAY); FL.sim = flSimPlan(words, Math.round((g ? g.wc : 40) * (kind === "practice" ? 0.95 : 0.85))); }
    document.querySelectorAll("header.top, main").forEach(e => { e.setAttribute("inert", ""); e.setAttribute("aria-hidden", "true"); });
    clearInterval(FL.tick); FL.tick = setInterval(flTick, 200);
    flRender();
  }
  function flClose() {
    FL.on = false; FL.sayGen++; flStopRec(true); clearInterval(FL.tick);
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
    const el = document.getElementById("fl"); if (el) el.remove();
    document.querySelectorAll("header.top, main").forEach(e => { e.removeAttribute("inert"); e.removeAttribute("aria-hidden"); });
    render();
  }
  function flStopRec(abort) { FL.recGen++; const r = FL.rec; FL.rec = null; if (r) { try { abort ? r.abort() : r.stop(); } catch (e) {} } }
  function flListen(kind, start, minPtr, restart) {
    FL.listen = kind;
    if (kind === "read") FL.seg = { start, minPtr, first: minPtr, restart, tokens: [], askedAt: Date.now(), deafMs: null };
    const gen = ++FL.recGen;
    const mine = () => FL.on && FL.recGen === gen;
    FL.listenAt = Date.now();
    try {
      FL.rec = flMakeRec({
        text: t => { if (!mine()) return; flHeard(flSpoken(t)); },
        error: e => { if (!mine()) return; flRecError(e); },
        end: () => { if (!mine()) return; FL.rec = null; flRecEnded(); },
        start: () => {   // the recognizer is listening now: words said before this never reached it
          if (!mine()) return;
          if (FL.awaitReady) { FL.awaitReady = false; FL.readyAt = Date.now(); }
          FL.busyTries = 0;
          if (FL.seg && FL.seg.deafMs == null) FL.seg.deafMs = Date.now() - FL.seg.askedAt;
          flPaintMic();
          const cm = document.getElementById("fl-checkmsg"); if (cm && FL.step === "check") cm.textContent = flCheckMsg();
        },
        level: v => { if (mine()) flVoiceLevel(v); }
      });
    } catch (e) { flFail(String(e.message || e)); }
  }
  function flWhy(e) {
    return DROID && { "not-allowed": "Fluid isn't allowed to use the microphone. In Android's Settings, open Apps › Fluid › Permissions, allow the microphone, then try again.",
        "service-not-allowed": "This device can't recognize speech on the device itself.", interrupted: "The reading stopped because Fluid left the screen. Start it again.",
        busy: "The device's speech recognizer is busy. Close any other app that listens (voice typing, an assistant, Live Caption), then press Try again.", "language-not-supported": "This device doesn't have Android's English speech pack yet. Get it under Microphone on Fluid's first screen.", "audio-capture": "The microphone isn't working. Check that no other app is using it, then try again." }[e]
        || { "not-allowed": "The microphone is blocked for this page. Allow it in the browser's site settings, then try again.", "service-not-allowed": "The microphone is blocked for this page.",
        "audio-capture": "No microphone was found. Plug one in and try again.", "language-not-supported": "This computer doesn't have the English speech pack yet. Get it under Microphone on Fluid's first screen.",
        network: "Speech recognition tried to use the network, so Fluid stopped it." }[e] || "Speech recognition stopped (" + e + ").";
  }
  function flRecError(e) {
    if (e === "no-speech" || e === "aborted") return;
    if (e === "phrases-not-supported") { FLS.phrases = false; return; }
    flStopRec(true);
    // The device's speech service said it's busy: try twice more, 2 seconds apart.
    if (/^busy/.test(e) && FL.busyTries++ < 2) {
      const step = FL.step, listen = FL.listen, op = FL.op;
      setTimeout(() => {
        if (!FL.on || FL.op !== op || FL.step !== step) return;
        if (listen === "check") flCheckMic();
        else if (listen === "read") { flCommit(); FL.awaitReady = true; flListen("read", FL.ptr, FL.ptr, true); }
        else if (listen === "repeat" && FL.rep) flRepeat(FL.rep.i, FL.rep.tries);
      }, 2000);
      return;
    }
    const why = flWhy(/^busy/.test(e) ? "busy" : e) + (/^busy-\d/.test(e) ? ` (${e})` : "");
    if (e === "language-not-supported") FLS.status = "downloadable";
    flFail(why);
  }
  function flFail(msg) { FL.err = msg; FL.step = "error"; FL.sayGen++; FL.speaking = false; flRender(); }
  // The recognizer can end on its own after a while; keep listening, starting a new stretch where the student is.
  function flRecEnded() {
    if (FL.settleFin) return FL.settleFin();
    if (FL.step === "stopping" && FL.stopFin) return FL.stopFin();
    if (FL.step === "read" && !FL.speaking && !FL.ended) { flCommit(); flListen("read", FL.ptr, FL.ptr, true); }
    else if (FL.step === "check" && !FL.speaking) flListen("check");
    else if (FL.step === "help" && FL.listen === "repeat" && !FL.speaking) flListen("repeat");
  }
  function flHeard(toks) {
    FL.tTok = Date.now();
    if (FL.listen === "check") { if (toks.length) { FL.listen = null; FL.step = "ready"; flRender(); flSay("Great, I can hear you.", flStartReading); } return; }
    if (FL.listen === "repeat") {
      const w = FL.words[FL.helpAt].n, i = FL.helpAt;
      if (toks.some(t => flSame(t, w) === 2)) { FL.listen = null; FL.rep = null; FL.inARow = 0; return flSay(`${flPick(FL_CHEER.praise)} Keep going.`, () => flResume(i + 1, i), { rate: 0.95 }); }
      if (toks.length && FL.rep) FL.rep.tTok = Date.now();
      return;
    }
    if (FL.listen !== "read" || (FL.ended && FL.step !== "stopping")) return;   // words heard just after the minute were said before it
    if (FL.awaitReady && toks.length) { FL.awaitReady = false; FL.readyAt = FL.listenAt; }   // words prove it was listening
    if (!FL.t0 && toks.length) {   // the clock starts with the first word
      const V = FL.vox, now = Date.now();
      FL.t0 = V.runStart && V.runStart >= FL.tBegin - 300 && now - V.at < 4000 ? V.runStart - 150 : now - 350; FL.tLast = FL.t0;
    }
    FL.seg.tokens = toks;
    flUpdate();
  }
  function flLive() { return FL.seg ? flSegment(FL.words, FL.seg) : { marks: {}, said: {}, last: -1 }; }
  function flCommit(upTo) {
    if (!FL.seg) return;
    const L = flLive(), end = upTo == null ? L.last : Math.min(L.last, upTo);
    for (let i = FL.seg.first; i <= end; i++) if (L.marks[i] && FL.marks[i] !== "s") { FL.marks[i] = L.marks[i]; if (L.said[i]) FL.said[i] = L.said[i]; }
    FL.seg = null;
  }
  function flMarksNow() { const m = FL.marks.slice(), L = flLive(); Object.keys(L.marks).forEach(k => { if (m[k] !== "s" && FL.seg && Number(k) >= FL.seg.first) m[k] = L.marks[k]; }); return m; }
  function flUpdate() {
    const L = flLive(), ptr = Math.max(FL.seg.minPtr, L.last + 1), now = Date.now();
    if (ptr > FL.ptr) { FL.ptr = ptr; FL.tLast = FL.vox.at && now - FL.vox.at < 2500 ? Math.max(FL.tLast, Math.min(now, FL.vox.at + 300)) : now; FL.inARow = 0; }
    if (!FL.timed && !FL.half && FL.n > 40 && FL.ptr >= FL.n / 2) { FL.half = true; flToast(flPick(FL_CHEER.half)); }
    if (!FL.timed && !FL.settling) {   // practice: fix a misread or skipped word once the student has clearly moved past it
      let cand = null;
      for (let i = FL.seg.first; i <= L.last - 1 && !cand; i++) {
        const m = L.marks[i];
        if (m === "o" && L.marks[i + 1] === "o" && L.marks[i + 2] === "o") cand = { i, skip: true };
        else if ((m === "x" || m === "o") && FL.marks[i] !== "s") cand = { i, skip: false };
      }
      if (!cand) FL.fix = null;
      else if (!FL.fix || FL.fix.i !== cand.i || FL.fix.skip !== cand.skip) FL.fix = { ...cand, t: now };
      else if (now - FL.fix.t >= FL_FIX_MS) { FL.fix = null; return cand.skip ? flSkipBack(cand.i) : flFix(cand.i); }
    }
    flPaint();
    if (FL.ptr >= FL.n) flFinish(false);
  }
  function flToast(text) { FL.caption = text; flPaintCaption(); setTimeout(() => { if (FL.caption === text) { FL.caption = ""; flPaintCaption(); } }, 2600); }
  // Fluid helps only when the student has gone quiet; while the microphone hears the student (the app says how loud), it waits.
  function flTick() {
    if (!FL.on) return;
    const now = Date.now();
    if (FL.step === "read") flPaintClock();
    flPaintMic();
    if (FL.step === "check") return flCheckTick(now);
    if (FL.step === "help" && FL.listen === "repeat" && !FL.speaking && !FL.settling) return flRepeatTick(now);
    if (FL.step !== "read" || FL.speaking || FL.ended || FL.settling) return;
    if (FL.fix && FL.seg && now - FL.fix.t >= FL_FIX_MS) return flUpdate();
    if (FL.timed) {   // the minute runs from the first word, or from when the microphone first heard the student
      const st = FL.t0 || (FL.vox.runStart && FL.vox.runStart >= FL.tBegin - 300 ? FL.vox.runStart - 150 : 0);
      if (st && now - st >= FL_TIMED * 1000 / (window.__fluidMinute || 1)) { if (!FL.t0) { FL.t0 = st; FL.tLast = st; } return flTimeUp(); }
    }
    if (FL.awaitReady) { if (now - FL.listenAt < 3000) return; FL.awaitReady = false; FL.readyAt = FL.listenAt; }
    const wait = FL.timed ? FL_WAIT.timed : FL_WAIT.practice, from = Math.max(FL.t0 ? FL.tLast : FL.tBegin, FL.readyAt);
    const since = now - from, quiet = now - Math.max(FL.vox.at, FL.tTok, from);
    const cap = wait + (FL.tTok > from ? 3000 : FL.vox.at > from ? 17000 : 2500);
    if ((since >= wait && quiet >= (FL.timed ? 1200 : 800)) || since >= cap) flStuck();
  }
  function flVoiceLevel(v) {
    const V = FL.vox, now = Date.now();
    if (!V.n++) V.floor = v;
    V.floor = v < V.floor ? v : Math.min(V.floor + 0.02, v);
    V.level = v;
    if (v - V.floor >= 2.5) { if (now - V.at > 1500) V.runStart = now; V.at = now; }
  }
  function flPaintMic() {
    const el = document.getElementById("fl-mic"); if (!el) return;
    const now = Date.now(), V = FL.vox, on = !!FL.rec && !FL.speaking && !FL.settling;
    const ready = on && !FL.awaitReady, hearing = ready && now - Math.max(V.at, FL.tTok) < 450;
    el.className = "flmicl" + (ready ? " ready" : "") + (hearing ? " on" : "") + (FL.speaking ? " hush" : "");
    el.style.setProperty("--lv", hearing && V.n ? Math.max(0.25, Math.min(1, (V.level - V.floor) / 7)).toFixed(2) : hearing ? "0.6" : "0");
    const lbl = el.querySelector(".lbl"), txt = ready ? "Listening" : on ? "One moment…" : "";
    if (lbl && lbl.textContent !== txt) lbl.textContent = txt;
  }
  function flSettle(then) {
    const r = FL.rec, ptr0 = FL.ptr, op = FL.op; let done = false;
    const fin = () => {
      if (done || FL.op !== op) return; done = true; FL.settling = false; FL.settleFin = null;
      flStopRec(true); flCommit();
      then(FL.ptr > ptr0);
    };
    FL.settling = true; FL.settleFin = fin; flPaintMic();
    try { r.stop(); } catch (e) { return fin(); }
    setTimeout(fin, 2000);
  }
  // The student stopped on a word for 3 seconds (2 in practice): say the word, as a DIBELS examiner would.
  function flStuck() {
    if (FL.rec && !FL.settling) return flSettle(moved => {
      if (!FL.on || FL.step !== "read" || FL.ended) return;
      if (moved) { flPaint(); return FL.ptr >= FL.n ? flFinish(false) : flResume(FL.ptr, null); }
      flHelpWord();
    });
    flHelpWord();
  }
  const flShow = i => FL.words[i].w.replace(/^[“"‘'(]+|[”"’'),.!?;:]+$/g, "");
  function flHelpWord() {
    const i = FL.ptr; if (i >= FL.n) return flFinish(false);
    if (!FL.t0) { FL.t0 = Date.now(); FL.tLast = FL.t0; }
    flCommit(i - 1);
    // Practice: after two stops in a row with no reading in between, the third pauses (the reader may have walked away).
    if (!FL.timed && FL.inARow >= 2) { FL.step = "paused"; flRender(); return flSay("Are you still there? Tap the green button when you're ready to read.", null, { keep: true }); }
    FL.marks[i] = "s"; FL.supplied++; FL.inARow++;
    const w = flShow(i);
    if (FL.timed) { FL.ptr = i + 1; FL.tLast = Date.now(); flPaint(i); return flSay(w, () => flResume(i + 1, i), { rate: 0.85 }); }
    FL.helpAt = i; FL.step = "help"; flPaint(i);
    flSay(`This word is ${w}. Say ${w}.`, () => flRepeat(i, 0), { rate: 0.95 });
  }
  // Practice: a word was misread or left out. Say it, have the student say it, then go on from the next word.
  function flFix(i) {
    flCommit(i);
    for (let k = i + 1; k < FL.n; k++) FL.marks[k] = null;
    FL.helped.add(i); FL.ptr = i + 1; FL.helpAt = i; FL.step = "help"; flPaint(i);
    const w = flShow(i);
    flSay(`Look again. It says ${w}. Say ${w}.`, () => flRepeat(i, 0), { rate: 0.95 });
  }
  function flSkipBack(i) {
    flCommit(i - 1);
    for (let k = i; k < FL.n; k++) FL.marks[k] = null;
    FL.ptr = i; FL.step = "help"; FL.helpAt = i; flPaint(i);
    flSay(`Oops, you skipped some words. Go back to the word ${flShow(i)}, and read from there.`, () => flResume(i, null), { rate: 0.95 });
  }
  // The student says the word back, and must say it right. Right: praise, and the reading goes on. Something else, or
  // nothing: the voice says the word again and listens again, up to FL_TRIES tries; then the reading goes on.
  const FL_TRIES = 3, FL_FIX_MS = 450;
  function flRepeat(i, tries) {
    FL.step = "help"; FL.helpAt = i; FL.rep = { i, tries: tries || 0, tTok: 0, listenAt: Date.now() };
    FL.awaitReady = true; flRender(); flListen("repeat");
  }
  function flRepeatTick(now) {
    const R = FL.rep; if (!R) return;
    if (FL.awaitReady) { if (now - FL.listenAt < 3000) return; FL.awaitReady = false; FL.readyAt = FL.listenAt; }
    const from = Math.max(R.listenAt, FL.readyAt), talking = now - FL.vox.at < 700;
    const decide = R.tTok ? now - R.tTok >= 900 : now - from >= 4500;
    if (!decide || talking) return;
    if (FL.rec && FL.vox.at > (R.tTok || from)) return flSettle(() => { if (FL.on && FL.listen === "repeat" && FL.rep === R) flRepeatMiss(R.tTok > 0); });
    flRepeatMiss(R.tTok > 0);
  }
  function flRepeatMiss(saidOther) {
    const R = FL.rep, i = R.i, w = flShow(i);
    FL.listen = null; FL.rep = null;
    if (R.tries + 1 >= FL_TRIES) return flSay(`Good try. The word is ${w}. Let's keep going.`, () => flResume(i + 1, i), { rate: 0.95 });
    flSay(saidOther ? `Not quite. Listen: ${w}. Now you say ${w}.` : `Your turn. Say ${w}.`, () => flRepeat(i, R.tries + 1), { rate: 0.9 });
  }
  function flResume(from, keep) {
    if (!FL.on || FL.ended) return;
    FL.step = "read"; FL.helpAt = -1; FL.ptr = Math.max(from, 0); FL.tLast = Date.now(); FL.tTok = 0;
    if (FL.ptr >= FL.n) return flFinish(false);
    flRender();
    FL.awaitReady = true;
    flListen("read", keep != null ? keep : FL.ptr, FL.ptr, true);
  }
  function flStartReading() {
    FL.step = "read"; FL.ptr = 0; FL.t0 = 0; FL.tBegin = Date.now() + 99999; flRender();
    const intro = FL.timed ? "Start at the top and read each word out loud. If you get stuck, I'll help you with the word. Do your best reading. Ready? Begin."
      : FL.best != null ? `Read the whole passage out loud. Your best today is ${FL.best} words a minute. Try to beat it! Ready? Begin.` : "Read the whole passage out loud. If you get stuck, I'll help. Ready? Begin.";
    flSay(intro, () => { FL.tBegin = Date.now(); FL.tLast = FL.tBegin; FL.awaitReady = true; flRender(); flListen("read", 0, 0, false); });
  }
  function flTimeUp() {
    FL.ended = true; FL.step = "stopping"; flRender();
    const r = FL.rec, op = FL.op; let done = false;
    const fin = () => { if (done || FL.op !== op) return; done = true; FL.stopFin = null; flFinish(true); };
    if (!r) return setTimeout(fin, 300);
    FL.stopFin = fin;
    try { r.stop(); } catch (e) { return fin(); }
    setTimeout(fin, 2500);
  }
  function flFinish(timeUp) {
    if (FL.step === "done" || FL.result) return;
    FL.ended = true;
    const now = Date.now();
    flCommit(); flStopRec(true);
    let last = -1; FL.marks.forEach((m, i) => { if (m) last = i; });
    const marks = FL.marks.slice(0, last + 1).map(m => m || "o").join("");
    const t0 = FL.t0 || now, secs = FL.timed ? (timeUp ? FL_TIMED : Math.min(FL_TIMED, Math.max(1, ((FL.tLast || now) - t0) / 1000))) : Math.min(1800, Math.max(1, ((FL.tLast || now) - t0) / 1000));
    const sc = flScore(marks, secs);
    const run = { pid: FL.pid, title: FL.passage.title, band: FL.passage.band, kind: FL.kind, mode: FL.mode, secs: Math.round(secs * 10) / 10, marks, ...sc,
      finished: last >= FL.n - 1, supplied: (marks.match(/s/g) || []).length, helped: FL.helped.size, at: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) };
    FL.result = run;
    // Kept in this page's memory only, until Fluid closes. Never who read it.
    if (FL.mode !== "sample") {
      S.runs.push(run);
      if (FL.kind === "practice" && run.finished) {
        const B = S.best[FL.pid] || {};
        S.best[FL.pid] = { wcpm: Math.max(B.wcpm || 0, run.wcpm), secs: B.secs ? Math.min(B.secs, run.secs) : run.secs };
      }
    }
    FL.step = "done"; FL.sayGen++; flRender();
    if (FL.kind === "practice") {
      const nb = FL.best != null && run.finished && run.wcpm > FL.best;
      flSay(`${run.finished ? "You did it!" : "Good reading."} You read ${run.wcpm} words a minute.${nb ? " That's a new best!" : ""}`);
    } else flSay(`Stop. Great reading! You read ${run.wcpm} words a minute.`);
  }
  // ---------- drawing the reading screen ----------
  function flPassageHTML(marks) {
    let html = "", para = -1;
    FL.words.forEach((w, i) => { if (w.para !== para) { html += (para >= 0 ? "</p>" : "") + "<p>"; para = w.para; } const m = marks ? marks[i] : ""; html += `<span class="flw${m && m !== "." && m !== "u" && m !== "c" ? " m-" + m : ""}" data-i="${i}">${esc(w.w)}</span> `; });
    return html + "</p>";
  }
  function flPaint(focus) {
    const el = document.getElementById("fl-text"); if (!el) return;
    const m = flMarksNow(), practice = !FL.timed;
    el.querySelectorAll(".flw").forEach(sp => {
      const i = Number(sp.dataset.i), k = m[i];
      let c = "flw";
      if (practice && k) c += k === "s" || FL.helped.has(i) ? " given" : " ok";
      if (practice && i === FL.ptr && FL.step === "read") c += " cur";
      if (i === focus || (FL.step === "help" && i === FL.helpAt)) c += " focus";
      sp.className = c;
    });
    const f = el.querySelector(".focus"); if (f) f.scrollIntoView({ block: "nearest" });
    const bar = document.getElementById("fl-bar"); if (bar) bar.style.width = Math.round((100 * Math.min(FL.ptr, FL.n)) / FL.n) + "%";
  }
  function flPaintClock() {
    const el = document.getElementById("fl-clock"); if (!el || FL.timed) return;
    el.textContent = FL.t0 ? flTime((Date.now() - FL.t0) / 1000) : "0:00";
  }
  function flPaintCaption() { const el = document.getElementById("fl-say"); if (el) { el.textContent = FL.caption || ""; el.classList.toggle("on", !!FL.caption); } }
  function goalLine(band) {
    const g = flGoal(band, band, ISO_TODAY);
    return g ? `Goal at this level: ${g.wc} words correct per minute and ${g.acc}% accuracy (${g.dibels ? g.basis.replace("DIBELS 8 goal", "DIBELS 8 benchmark") + "; Odin's passages are a guide, not a DIBELS score" : g.basis}).` : "";
  }
  function flRender() {
    const el = flEl(), P = FL.passage, practice = !FL.timed, sample = FL.mode === "sample";
    let body = "";
    if (FL.exitAsk) body = `<div class="smcard"><h2>Stop reading?</h2><p>This reading won't count.</p>
        <div class="smrow"><button class="btn big" data-flx="back">Keep reading</button><button class="btn ghost" data-flx="leave">Stop</button></div></div>`;
    else if (FL.step === "hello") body = `<div class="smcard"><p class="smkind">${esc(KIND[FL.kind])}${sample ? " · sample" : ""}</p><h2>${sample ? "A sample reading" : "Hi, reader!"}</h2>
        <p class="smbig">${sample ? "Watch and listen: a pretend reader reads, and Fluid helps." : practice ? "Read the whole passage out loud. Try to beat your best!" : "Read out loud for one minute. Do your best reading."}</p>
        <p>${sample ? "The pretend reader stops on one word, misreads one and fixes another." : "If you get stuck on a word, I'll help you."}</p>
        ${practice && FL.best != null ? `<p class="flbest">Your best on this passage today: <b>${FL.best}</b> words a minute${FL.fastest ? ` · <b>${flTime(FL.fastest)}</b>` : ""}</p>` : ""}
        <button class="btn big" data-flx="go">Start</button></div>`;
    else if (FL.step === "check") body = `<div class="smcard"><p class="smkind">Microphone check</p><h2>Say: “I am ready to read!”</h2>
        <p class="flmic ${FL.checkTries ? "warn" : ""}" id="fl-checkmsg">${flCheckMsg()}</p>
        <div class="smrow">${FL.checkTries ? `<button class="btn" data-flx="go">Try again</button>` : ""}<button class="btn ghost" data-flx="leave">Back</button></div></div>`;
    else if (FL.step === "error") body = `<div class="smcard"><h2>The microphone stopped.</h2><p>${esc(FL.err || "Something went wrong.")}</p><div class="smrow"><button class="btn big" data-flx="retry">Try again</button><button class="btn ghost" data-flx="leave">Back</button></div></div>`;
    else if (FL.step === "done") {
      const r = FL.result, nb = practice && FL.best != null && r.finished && r.wcpm > FL.best, fast = practice && FL.fastest != null && r.finished && r.secs < FL.fastest;
      const errs = { x: (r.marks.match(/x/g) || []).length, s: (r.marks.match(/s/g) || []).length, o: (r.marks.match(/o/g) || []).length };
      body = `<div class="smcard wide fldone"><h2>${practice ? `${r.finished ? "You did it!" : "Good reading!"}${nb ? " New best!" : ""}` : "Great reading!"}</h2>
          <div class="flstats"><div><b>${r.wcpm}</b><span>words correct per minute${FL.best != null ? ` · best before ${FL.best}` : ""}</span></div><div><b>${flTime(r.secs)}</b><span>${practice ? (r.finished ? "to read it all" : "of reading") : "of reading"}${fast ? " · fastest yet!" : ""}</span></div><div><b>${r.acc}%</b><span>of words right · ${plural(r.correct, "word")} correct</span></div></div>
          <p class="flgoal small">${esc(goalLine(P.band))}</p>
          <div class="legend"><span class="lx">misread ${errs.x}</span><span class="ls">said for the reader ${errs.s}</span><span class="lo">left out ${errs.o}</span>${practice && r.helped ? `<span>fixed with help ${r.helped}</span>` : ""}</div>
          <div class="fltext marks">${flPassageHTML(r.marks)}</div>
          ${sample ? `<p class="muted">This was a sample reading by a pretend reader.</p>` : `<p class="muted small">Fluid keeps this only until it closes, and never who read it.</p>`}
          <div class="smrow"><button class="btn big" data-flx="again">Read it again</button><button class="btn ghost" data-flx="leave">Done</button></div></div>`;
    } else {   // ready, read, help, paused, stopping
      body = `<div class="flread ${FL.timed ? "timed" : "practice"}">
        <div class="flhead"><span class="smkind">${esc(P.title)}</span><span id="fl-mic" class="flmicl" aria-hidden="true"><i></i><span class="lbl"></span></span>${practice ? `<span class="flclock" aria-label="Time"><span id="fl-clock">0:00</span>${FL.best != null ? ` <span class="muted">· best ${FL.best} words a minute${FL.fastest ? ", " + flTime(FL.fastest) : ""}</span>` : ""}</span>` : `<span class="muted small">${FL.step === "stopping" ? "Time!" : ""}</span>`}</div>
        ${practice ? `<div class="flprog"><i id="fl-bar"></i></div>` : ""}
        <div id="fl-text" class="fltext ${P.band <= 1 ? "big" : ""}">${flPassageHTML()}</div>
        ${FL.step === "paused" ? `<div class="smrow"><button class="btn big flgo" data-flx="resume">I'm ready</button></div>` : ""}
      </div>`;
    }
    el.innerHTML = `<div class="smtop"><span>${esc(P.title)} · ${esc(KIND[FL.kind])}${sample ? " · sample" : ""}</span><button class="btn ghost sm" data-flx="stop">${FL.step === "done" ? "Close" : "Stop"}</button></div>
      <div class="smbody">${body}<div id="fl-say" class="flsay" role="status" aria-live="polite"></div></div>`;
    flPaint(); flPaintCaption(); flPaintClock();
    const h = el.querySelector("h2"); if (h && FL.step !== "read") { h.setAttribute("tabindex", "-1"); }
  }
  const flCheckMsg = () => FL.checkTries ? `I can't hear you yet. Speak a little louder, close to the ${DROID ? "tablet" : "computer"}.`
    : FL.awaitReady ? "Getting the microphone ready…" : "Listening… say it now.";
  function flCheckMic() {
    FL.step = "check"; FL.awaitReady = true; FL.readyAt = 0; flRender(); flListen("check");
  }
  function flCheckTick(now) {
    if (FL.listen !== "check" || !FL.rec) return;
    if (FL.awaitReady) { if (now - FL.listenAt < 30000) return; FL.awaitReady = false; FL.readyAt = FL.listenAt; }
    if (now - FL.readyAt >= 8000) { FL.checkTries++; FL.listen = null; flStopRec(true); flRender(); }
  }
  function flClick(t) {
    const a = t.dataset.flx;
    if (a === "stop") { if (["hello", "done", "error", "check"].includes(FL.step) || FL.mode === "sample") return flClose(); FL.exitAsk = true; }
    else if (a === "back") FL.exitAsk = false;
    else if (a === "leave") return flClose();
    else if (a === "go") return flCheckMic();
    else if (a === "retry") { const { pid, kind, mode } = FL; FL.sayGen++; flStopRec(true); clearInterval(FL.tick); flOpen(pid, kind, mode); return flCheckMic(); }
    else if (a === "resume") { FL.inARow = 0; return flResume(FL.ptr, null); }
    else if (a === "again") { const { pid, kind, mode } = FL; FL.sayGen++; flStopRec(true); clearInterval(FL.tick); flOpen(pid, kind, mode); FL.step = "ready"; flRender(); return flStartReading(); }
    flRender();
  }
  document.addEventListener("click", e => { if (!FL.on) return; const t = e.target.closest("[data-flx]"); const box = document.getElementById("fl"); if (t && box && box.contains(t)) flClick(t); });
  document.addEventListener("keydown", e => { if (FL.on && e.key === "Escape" && !FL.exitAsk) { const b = document.querySelector('#fl [data-flx="stop"]'); if (b) { e.preventDefault(); flClick(b); } } });

  // =====================================================================================================
  // The AI that writes new passages: on a school computer (Ollama, LM Studio), a free tier or a paid service. Fluid calls it
  // from this page (in the Android app, the app makes the call). A key typed here is kept only while Fluid is open.
  // The AI is told only the level, the kind of text and the topic.
  // =====================================================================================================
  const AIC = { provider: "ollama", url: "", model: "", key: "" };
  (function () { const c = STORE.get("fluid.ai", null); if (c && AI_BY_ID[c.provider]) Object.assign(AIC, { provider: c.provider, url: String(c.url || ""), model: String(c.model || "") }); })();
  const aiSaveLocal = () => STORE.set("fluid.ai", { provider: AIC.provider, url: AIC.url, model: AIC.model });   // never the key
  const aiNow = () => { const P = AI_BY_ID[AIC.provider] || AI_BY_ID.custom; return { P, url: AIC.url || P.url, model: AIC.model || P.model }; };
  const aiSummary = () => { const { P, model } = aiNow(); return `${P.name}${model ? " · " + model : ""}${P.key === true && !AIC.key ? " · needs a key" : ""}`; };
  // In the Android app, the app makes the call (the page itself reaches nothing but the app).
  const bridgeFetch = async (url, init) => {
    const r = await askApp("ai", { url, headers: init.headers, body: init.body }, 200000);
    if (!r || !r.status) throw new TypeError((r && r.error) || "no answer");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body || "" };
  };
  const aiAsk = prompt => aiChat(AIC, prompt, BR ? { fetch: bridgeFetch } : {});
  function aiPanel() {
    const { P, url, model } = aiNow(), kinds = [["local", "On a computer at school (free, private)"], ["free", "Free tier (a free key, with daily limits)"], ["paid", "Paid (a key from the service)"], ["custom", "Other"]];
    return `<details class="aiset" ${S.aiOpen ? "open" : ""} id="ai-details"><summary class="small"><b>AI settings</b> · ${esc(aiSummary())}</summary>
      <label class="field">AI<select id="ai-provider">${kinds.map(([k, l]) => `<optgroup label="${esc(l)}">${AI_PROVIDERS.filter(p => p.kind === k).map(p => `<option value="${p.id}" ${p.id === P.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>`).join("")}</select></label>
      <p class="small muted">${esc(P.help)}${P.keyUrl ? ` <a href="${P.keyUrl}" target="_blank" rel="noopener">Get a key</a>.` : ""}</p>
      <label class="field">Address<input id="ai-url" value="${esc(url)}" spellcheck="false" autocapitalize="off"></label>
      <label class="field">Model<input id="ai-model" value="${esc(model)}" spellcheck="false" autocapitalize="off"></label>
      ${P.key ? `<label class="field">Key<input id="ai-key" type="password" autocomplete="off" value="${esc(AIC.key)}" placeholder="kept only while Fluid is open"></label>` : ""}
      <p class="small muted">Fluid calls the AI itself. A key you type is kept only while Fluid is open: it's never saved.${BR ? " In the app, the AI's address must start with https://." : " A page on the internet can reach Ollama on your own computer only if Ollama allows it (OLLAMA_ORIGINS)."} Model names change: if one isn't found, check the service's list of models.</p>
      <div class="row"><button class="btn sm" data-a="aisave">Use these settings</button><button class="btn ghost sm" data-a="aitest" ${S.aiBusy ? "disabled" : ""}>Test it</button></div>
      ${S.aiMsg ? `<p class="small ${S.aiOk === false ? "warnx" : ""}" role="status">${esc(S.aiMsg)}</p>` : ""}
    </details>`;
  }
  function aiReadForm() {
    const d = $("#ai-details"); if (d) S.aiOpen = d.open;
    const v = id => { const el = $("#" + id); return el ? el.value.trim() : null; };
    const p = v("ai-provider"); if (p && AI_BY_ID[p]) AIC.provider = p;
    const u = v("ai-url"), m = v("ai-model"), k = v("ai-key");
    if (u != null) AIC.url = u; if (m != null) AIC.model = m; if (k != null) AIC.key = k;
  }

  // ---------- new passages ----------
  const newDraft = () => ({ band: S.level == null ? 2 : S.level, genre: "story", topic: "", busy: false, err: "", draft: null, src: "" });
  function addRead() {
    const N = S.add = S.add || newDraft(), v = id => document.getElementById(id);
    if (v("fln-band")) N.band = Number(v("fln-band").value); if (v("fln-genre")) N.genre = v("fln-genre").value; if (v("fln-topic")) N.topic = v("fln-topic").value.trim();
    if (N.draft && v("fln-title")) { N.draft.title = v("fln-title").value; N.draft.text = v("fln-text").value; }
    const d = $("#ai-details"); if (d) S.aiOpen = d.open;
    return N;
  }
  function addPanel() {
    const N = S.add || newDraft(), list = addedPassages(), D = N.draft;
    return `<section class="panel" id="fl-added" aria-labelledby="add-h">
      <div class="head"><h2 id="add-h">New passages</h2><span class="muted small">Write one with AI, or type or paste your own</span></div>
      <p class="small">The AI is told only the level, the kind of text and your topic. Leave students' names out of the topic. Read every passage before you save it: it's kept on this device, next to Odin's 36 passages.</p>
      <div class="row"><label class="field">Level<select id="fln-band">${[0, 1, 2, 3, 4, 5].map(b => `<option value="${b}" ${b === N.band ? "selected" : ""}>${b === 0 ? "Kindergarten" : "Grade " + b}</option>`).join("")}</select></label>
        <label class="field">Kind<select id="fln-genre"><option value="story" ${N.genre === "story" ? "selected" : ""}>Story</option><option value="information" ${N.genre === "information" ? "selected" : ""}>Informational</option></select></label>
        <label class="field" style="flex:1 1 200px">Topic<input id="fln-topic" maxlength="80" value="${esc(N.topic)}" placeholder="a class garden, volcanoes, soccer…"></label></div>
      <div class="row"><button class="btn" data-a="write" ${N.busy ? "disabled" : ""}>${N.busy ? "Writing… (a model on a school computer can take a minute)" : "Write it with AI"}</button><button class="btn ghost" data-a="type">Type or paste one</button></div>
      ${aiPanel()}
      ${N.err ? `<div class="notice bad" role="alert"><b>${esc(N.err)}</b></div>` : ""}
      ${D ? `<div style="display:grid;gap:8px">
          <label class="field">Title<input id="fln-title" maxlength="60" value="${esc(D.title)}"></label>
          <label class="field">Passage <span class="muted">(a blank line starts a new paragraph)</span><textarea id="fln-text" rows="${N.band <= 1 ? 8 : 12}">${esc(D.text)}</textarea></label>
          <p class="small"><span id="fln-count">${D.words}</span> words · ${flLevel(N.band).toLowerCase()}, where Odin's passages have about ${AI_WORDS[N.band]}${N.src ? ` · from ${esc(N.src)}` : ""}</p>
          ${D.warnings.length ? `<ul class="small">${D.warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
          <div class="row"><button class="btn" data-a="psave">Save passage</button><button class="btn ghost" data-a="pcheck">Check it again</button>${N.src.startsWith("AI") ? `<button class="btn ghost" data-a="write">Write another</button>` : ""}<button class="btn ghost" data-a="pdrop">Discard</button></div>
        </div>` : ""}
      ${list.length ? `<div class="scroller"><table class="runs"><thead><tr><th>Passage</th><th>Level</th><th>Words</th><th>From</th><th></th></tr></thead><tbody>
        ${list.map(p => `<tr><td>${esc(p.title)} <span class="mono small muted">${p.id}</span></td><td>${LEVEL_SHORT(p.band)}</td><td class="n">${flPassageWords(p.id).length}</td><td class="small">${esc(p.source || "")}</td>
          <td>${S.confirmDel === p.id ? `<button class="linkbtn" data-a="pdelyes" data-id="${p.id}">Delete it</button> · <button class="linkbtn" data-a="pdelno">Keep</button>` : `<button class="linkbtn" data-a="pdel" data-id="${p.id}">Delete</button>`}</td></tr>`).join("")}</tbody></table></div>` : `<p class="small muted">No passages added yet.</p>`}
    </section>`;
  }
  async function writePassage() {
    const N = addRead(); aiReadForm(); N.err = ""; N.busy = true; render();
    try {
      const t = await aiAsk(aiPromptPassage({ band: N.band, topic: N.topic, genre: N.genre }));
      N.draft = aiParsePassage(t, { band: N.band }); N.src = "AI: " + aiSummary();
    } catch (e) { N.err = String(e.message || e); }
    N.busy = false; render();
    const el = $("#fl-added"); if (el) el.scrollIntoView({ block: "nearest" });
  }
  function savePassage() {
    const N = addRead(), D = aiCleanPassage(N.draft.title, N.draft.text, N.band);
    N.draft = D;
    if (D.words < 20) { N.err = "A passage needs at least 20 words."; return render(); }
    let n = 0; addedPassages().filter(p => p.band === N.band).forEach(p => { n = Math.max(n, Number(p.id.split("-")[1])); });
    const id = `A${N.band}-${n + 1}`;
    flAddPassages([{ id, band: N.band, title: D.title, text: D.text, topic: N.topic, source: (N.src || "typed in").slice(0, 120) }]); saveAdded();
    S.add = null; S.level = N.band; S.open = id;
    say(`Saved “${D.title}”, a ${flLevel(N.band).toLowerCase()} passage. It's in the list below.`, "ok");
    render(); window.scrollTo({ top: 0 });
  }

  // ---------- the page ----------
  function say(text, kind) { S.notice = text; S.noticeKind = kind || ""; }
  const ICON = `<svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent-soft)"/><path d="M6 11h14M6 16h20M6 21h11" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round"/><path d="M19 22c2-3 4-3 6 0" stroke="var(--ongrade)" stroke-width="2.4" fill="none" stroke-linecap="round"/></svg>`;
  function micPanel() {
    const [cls, txt] = flStatusText(FLS.status);
    const btns = [];
    if (FLS.status === "manual") btns.push(`<button class="btn sm" data-a="check">Check this browser</button>`);
    if (FLS.status === "downloadable" && !FLS.installing) btns.push(`<button class="btn sm" data-a="install">Get the speech pack</button>`);
    if (["unavailable", "downloading", "denied", "downloadable", "none"].includes(FLS.status) && !FLS.installing && (FLS.status !== "none" || DROID)) btns.push(`<button class="btn ghost sm" data-a="check">Check again</button>`);
    return `<div class="flstatus ${cls}" id="mic"><span>${txt}${FL_ON_ANDROID && FLS.status !== "available" ? ` On an Android phone or tablet, use the <a href="${APK}">Fluid app for Android</a>: it listens on the device.` : ""}</span>${btns.join("")}</div>`;
  }
  function libraryPanel() {
    const lv = S.level, levels = [0, 1, 2, 3, 4, 5];
    const list = lv == null ? [] : FL_PASSAGES.filter(p => p.band === lv);
    const ready = flReady();
    return `<section class="panel" aria-labelledby="read-h">
      <div class="head"><h2 id="read-h">Read a passage</h2><span class="muted small">${FL_PASSAGES.length} passages, kindergarten to grade 5</span></div>
      ${micPanel()}
      <div class="levels" role="group" aria-label="Level">${levels.map(b => `<button data-a="level" data-v="${b}" aria-pressed="${lv === b}">${b === 0 ? "Kindergarten" : "Grade " + b}</button>`).join("")}</div>
      ${lv == null ? `<p class="small muted">Choose a level to see its passages.</p>` : `<div class="plist">${list.map(p => passageItem(p, ready)).join("")}</div>`}
    </section>`;
  }
  function passageItem(p, ready) {
    const words = flPassageWords(p.id), open = S.open === p.id, B = S.best[p.id];
    let html = `<button class="pitem" data-a="open" data-id="${p.id}" aria-expanded="${open}"><b>${esc(p.title)}</b><span class="row">${p.added ? `<span class="tag">added</span>` : ""}<span class="small muted">${words.length} words</span></span>
      <span class="meta">${esc(String(p.text).split(/\s+/).slice(0, 14).join(" "))}…${B ? ` · best today ${B.wcpm} words a minute` : ""}</span></button>`;
    if (!open) return html;
    const paras = String(p.text).split(/\n\s*\n/).map(t => `<p>${esc(t)}</p>`).join("");
    html += `<div class="pick" id="pick">
      <div class="preview" aria-label="The passage">${paras}</div>
      <p class="small muted">${flLevel(p.band)} · ${words.length} words. ${esc(goalLine(p.band))}</p>
      <div class="modes">
        <button class="mode main" data-a="read" data-kind="practice" data-id="${p.id}" ${ready ? "" : "disabled"}><b>Practice</b><span>Read the whole passage. Fluid helps with a missed word and has the reader say it again.</span></button>
        <button class="mode" data-a="read" data-kind="minute" data-id="${p.id}" ${ready ? "" : "disabled"}><b>One-minute reading</b><span>Read for one minute, as in DIBELS. Fluid says a word after a 3-second stop.</span></button>
        <button class="mode" data-a="sample" data-id="${p.id}"><b>Watch a sample reading</b><span>A pretend reader reads, and Fluid helps. No microphone needed.</span></button>
      </div>
      ${ready ? "" : `<p class="small muted">Practice and the one-minute reading need the microphone: see above.</p>`}
    </div>`;
    return html;
  }
  function runsPanel() {
    if (!S.runs.length) return "";
    return `<section class="panel" aria-labelledby="runs-h"><div class="head"><h2 id="runs-h">Readings so far</h2><button class="btn ghost sm" data-a="clearruns">Clear</button></div>
      <p class="small muted">Kept only until Fluid closes. Fluid never asks who is reading.</p>
      <div class="scroller"><table class="runs"><thead><tr><th>Time</th><th>Passage</th><th>Kind</th><th>Words correct per minute</th><th>Accuracy</th></tr></thead><tbody>
      ${S.runs.slice().reverse().map(r => `<tr><td class="small">${esc(r.at)}</td><td>${esc(r.title)} <span class="small muted">${LEVEL_SHORT(r.band)}</span></td><td class="small">${KIND[r.kind]}${r.kind === "practice" ? (r.finished ? "" : " (part)") : ""}</td><td class="n">${r.wcpm}</td><td class="n">${r.acc}%</td></tr>`).join("")}
      </tbody></table></div></section>`;
  }
  function aboutPanel() {
    return `<section class="panel" aria-labelledby="about-h"><h2 id="about-h">How Fluid works</h2>
      <ul class="small" style="margin:0;padding-left:1.2em;display:grid;gap:6px">
        <li><b>Practice:</b> the reader reads the whole passage out loud. When a word is misread or the reader stops for 2 seconds, Fluid says the word and listens for the reader to say it back, then praises and goes on. Words read turn green.</li>
        <li><b>One-minute reading:</b> like a DIBELS 8 oral reading fluency check: one minute, and Fluid says a word after a 3-second stop. The score is words correct per minute and accuracy.</li>
        <li><b>Privacy:</b> speech is recognized on the device only, so a reader's voice never leaves it, and nothing is recorded. Fluid never asks who is reading, and keeps the readings only until it closes. It keeps passages you add and which AI you chose, on this device; never a key.</li>
        <li>The passages, the scoring and the reading screen come from Odin (Project Cerberus), its fluency practice.</li>
      </ul>
      <p class="small muted">Fluid ${esc(FLUID.version)} · Odin ${esc(FLUID.odin.odinVersion)}'s fluency practice${DROID ? " · Android app" : ""}${DROID || FL_ON_ANDROID ? "" : ` · <a href="${APK}">Fluid for Android</a>`}</p>
    </section>`;
  }
  function render() {
    if (FL.on) return;
    const app = $("#app");
    app.innerHTML = `<header class="top"><div class="wrap"><div class="brand">${ICON}<div><h1>Fluid</h1><div class="sub">Fluency reading practice</div></div></div><span class="chip">Nothing about readers is kept</span></div></header>
      <main class="wrap">
        ${S.notice ? `<div class="notice ${S.noticeKind}" role="status">${esc(S.notice)}</div>` : ""}
        ${libraryPanel()}${runsPanel()}${addPanel()}${aboutPanel()}
      </main>`;
  }

  document.addEventListener("click", e => {
    if (FL.on) return;
    const t = e.target.closest("[data-a]"); if (!t) return;
    const a = t.dataset.a;
    if (a === "level") { const v = Number(t.dataset.v); S.level = S.level === v ? null : v; S.open = null; say(null); render(); }
    else if (a === "open") { S.open = S.open === t.dataset.id ? null : t.dataset.id; say(null); render(); const p = $("#pick"); if (p) p.scrollIntoView({ block: "nearest" }); }
    else if (a === "read") flOpen(t.dataset.id, t.dataset.kind, "voice");
    else if (a === "sample") flOpen(t.dataset.id, "practice", "sample");
    else if (a === "check") flCheckSpeech(false);
    else if (a === "install") flInstall();
    else if (a === "clearruns") { S.runs = []; S.best = {}; render(); }
    else if (a === "write") writePassage();
    else if (a === "type") { const N = addRead(); N.err = ""; N.src = "typed in"; N.draft = { title: "", text: "", words: 0, warnings: [] }; render(); const el = $("#fln-title"); if (el) el.focus(); }
    else if (a === "pcheck") { const N = addRead(); N.draft = aiCleanPassage(N.draft.title, N.draft.text, N.band); render(); }
    else if (a === "psave") savePassage();
    else if (a === "pdrop") { S.add = null; render(); }
    else if (a === "pdel") { S.confirmDel = t.dataset.id; render(); }
    else if (a === "pdelno") { S.confirmDel = null; render(); }
    else if (a === "pdelyes") { flDropPassage(t.dataset.id); saveAdded(); if (S.open === t.dataset.id) S.open = null; S.confirmDel = null; say("The passage is deleted.", "ok"); render(); }
    else if (a === "aisave") { aiReadForm(); aiSaveLocal(); S.aiMsg = "Fluid uses " + aiSummary() + "."; S.aiOk = true; addRead(); render(); }
    else if (a === "aitest") {
      aiReadForm(); addRead(); S.aiBusy = true; S.aiMsg = "Asking the AI…"; S.aiOk = null; render();
      aiAsk({ system: AI_SYSTEM, user: 'Reply with this JSON and nothing else: {"ok": true}', maxTokens: 60 }).then(t => { aiJSON(t); S.aiMsg = "It works: the AI answered."; S.aiOk = true; })
        .catch(e => { S.aiMsg = String(e.message || e); S.aiOk = false; }).finally(() => { S.aiBusy = false; render(); });
    }
  });
  document.addEventListener("change", e => {
    if (FL.on) return;
    const t = e.target;
    if (t.id === "ai-provider") { aiReadForm(); addRead(); const P = AI_BY_ID[t.value]; AIC.url = P.url; AIC.model = P.model; AIC.key = ""; S.aiMsg = ""; render(); }
    else if (t.id === "fln-band" || t.id === "fln-genre") addRead();
  });
  document.addEventListener("input", e => {
    if (e.target.id === "fln-text" && S.add && S.add.draft) { const n = e.target.value.split(/\s+/).filter(Boolean).length, el = $("#fln-count"); if (el) el.textContent = String(n); S.add.draft.text = e.target.value; }
    if (e.target.id === "fln-title" && S.add && S.add.draft) S.add.draft.title = e.target.value;
    if (e.target.id === "fln-topic") (S.add = S.add || newDraft()).topic = e.target.value;
  });
  document.addEventListener("toggle", e => { if (e.target.id === "ai-details") S.aiOpen = e.target.open; }, true);
  // The Android app's back button: stay while reading (and ask whether to stop).
  window.__fluidBack = () => { if (!FL.on) return ""; const b = document.querySelector('#fl [data-flx="stop"]'); if (b) flClick(b); return "stay"; };
  // The app says when Fluid leaves the screen: the microphone and the voice stop there, and the reading stops.
  if (DROID && DROID.on) DROID.on(ev => { if (ev === "hidden" && FL.on && FL.mode !== "sample" && !["done", "hello"].includes(FL.step)) flFail(flWhy("interrupted")); });

  // For the tests: what Fluid is doing, and a quick sample.
  window.__fluid = {
    state: () => ({ level: S.level, open: S.open, speech: FLS.status, reading: FL.on ? { step: FL.step, kind: FL.kind, mode: FL.mode, ptr: FL.ptr, n: FL.n, marks: FL.marks.map(m => m || "-").join("") } : null, runs: S.runs.length, android: !!DROID, version: FLUID.version }),
    result: () => FL.result,
    runs: () => S.runs.slice(),
    passages: () => FL_PASSAGES.map(p => ({ id: p.id, band: p.band, title: p.title, added: !!p.added })),
    ai: () => ({ provider: AIC.provider, url: AIC.url, model: AIC.model, hasKey: !!AIC.key }),
    speech: s => { FLS.status = s; render(); }
  };

  render();
  flCheckSpeech(true);
  if (DROID && DROID.info) DROID.info.then(i => { if (i && i.app) FLUID.app = i.app; });
})();
