// =====================================================================================================
// Odin 0.7: the Odin app for Android. The app shows this page and adds a bridge object, OdinAndroid, only for
// Odin's own address. Through it, Odin uses Android's ON-DEVICE speech recognizer (the student's voice never
// leaves the phone, nothing is recorded) and the phone's own voice. This file makes the bridge look like the
// browser's speech objects, so the fluency and practice code works the same in Chrome and in the app.
// In a browser there is no bridge, and this file does nothing.
// =====================================================================================================
(function () {
  const B = typeof window !== "undefined" && window.OdinAndroid;
  if (!B || typeof B.postMessage !== "function") return;
  let seq = 0;
  const waits = new Map(), recs = new Map(), says = new Map(), appFns = [];
  const send = m => { try { B.postMessage(JSON.stringify(m)); } catch (e) {} };
  const ask = (t, extra, ms) => new Promise(res => {
    const id = "q" + (++seq); waits.set(id, res); send(Object.assign({ t, id }, extra || {}));
    setTimeout(() => { if (waits.has(id)) { waits.delete(id); res(null); } }, ms || 8000);
  });
  const later = f => setTimeout(f, 0);

  // ---------- speech recognition, on the device only ----------
  class OdinRec {
    constructor() {
      Object.assign(this, { lang: "en-US", continuous: false, interimResults: false, maxAlternatives: 1, phrases: [],
        onresult: null, onerror: null, onend: null, onstart: null, onsoundlevel: null, onspeechstart: null, onspeechend: null, _id: null, _res: [], _ended: true });
    }
    // Android's on-device recognizer is the only one the app uses, so this is always true.
    get processLocally() { return true; }
    set processLocally(v) {}
    start() {
      if (!this._ended) throw new Error("This recognizer has already started.");
      this._id = "r" + (++seq); this._ended = false; this._res = []; recs.set(this._id, this);
      const bias = [].concat(this.phrases || []).map(p => (p && typeof p === "object" ? p.phrase : p)).filter(x => typeof x === "string" && x).slice(0, 150);
      send({ t: "listen", id: this._id, lang: this.lang || "en-US", continuous: !!this.continuous, interim: !!this.interimResults, bias });
    }
    stop() { if (this._id && !this._ended) send({ t: "stop", id: this._id }); }
    abort() { if (this._id && !this._ended) { send({ t: "abort", id: this._id }); this._finish(); } }
    _finish() {
      if (this._ended) return; this._ended = true; recs.delete(this._id);
      const f = this.onend; if (f) later(() => f.call(this, { type: "end" }));
    }
    _ev(m) {
      if (this._ended) return;
      if (m.ev === "start") { if (this.onstart) this.onstart({ type: "start" }); }
      else if (m.ev === "partial" || m.ev === "final") {
        if (m.ev === "partial" && !this.interimResults) return;
        const i = Math.max(0, m.i | 0); this._res[i] = { text: String(m.text || ""), final: m.ev === "final" };
        const results = [];
        for (let k = 0; k < this._res.length; k++) {
          const r = this._res[k] || { text: "", final: true };
          const alt = [{ transcript: r.text, confidence: r.final ? 0.9 : 0 }]; alt.isFinal = r.final; alt.item = n => alt[n];
          results.push(alt);
        }
        results.item = n => results[n];
        if (this.onresult) this.onresult({ type: "result", resultIndex: i, results });
      }
      // 0.8.2: how loud the microphone hears the room, a few times a second (Odin's own event: browsers have none),
      // and Android's "the student started / stopped talking".
      else if (m.ev === "level") { if (this.onsoundlevel) this.onsoundlevel({ type: "soundlevel", level: Number(m.v) || 0 }); }
      else if (m.ev === "speechstart") { if (this.onspeechstart) this.onspeechstart({ type: "speechstart" }); }
      else if (m.ev === "speechend") { if (this.onspeechend) this.onspeechend({ type: "speechend" }); }
      else if (m.ev === "error") { if (this.onerror) this.onerror({ type: "error", error: m.error || "error", message: m.message || "" }); }
      else if (m.ev === "end") this._finish();
    }
  }
  // 0.9.1: the app may first ask Android for the microphone, so wait for the person to answer (up to 2 minutes).
  // "denied": the microphone isn't allowed for the app.
  OdinRec.available = async o => { const r = await ask("status", { lang: (o && o.langs && o.langs[0]) || "en-US" }, 120000); OdinRec.why = (r && r.why) || (r ? "" : "no-answer"); return (r && r.state) || "unavailable"; };
  OdinRec.install = async o => {
    const r = await ask("install", { lang: (o && o.langs && o.langs[0]) || "en-US" }, 15 * 60000);
    OdinRec.note = (r && r.note) || ""; return !!(r && r.ok);
  };

  // ---------- the phone's own voice ----------
  class OdinUtterance {
    constructor(text) { Object.assign(this, { text: text == null ? "" : String(text), lang: "en-US", rate: 1, pitch: 1, volume: 1, voice: null, onstart: null, onend: null, onerror: null }); }
    addEventListener(type, f) { this["on" + type] = f; }
  }
  const VOICE = { name: "Android", lang: "en-US", localService: true, default: true, voiceURI: "android" };
  const synth = {
    speaking: false, pending: false, paused: false, onvoiceschanged: null,
    speak(u) {
      const id = "s" + (++seq); says.set(id, u); synth.speaking = true;
      send({ t: "say", id, text: String(u.text || ""), rate: Number(u.rate) || 1, pitch: Number(u.pitch) || 1, lang: u.lang || "en-US" });
    },
    cancel() {
      send({ t: "hush" });
      const all = [...says.values()]; says.clear(); synth.speaking = false;
      all.forEach(u => { if (u.onerror) later(() => u.onerror({ type: "error", error: "interrupted" })); });
    },
    getVoices() { return [VOICE]; }, pause() {}, resume() {}, addEventListener() {}, removeEventListener() {}
  };

  // ---------- messages from the app ----------
  const onMsg = ev => {
    let m; try { m = JSON.parse(ev && ev.data); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    if (m.t === "reply" && waits.has(m.id)) { const f = waits.get(m.id); waits.delete(m.id); f(m); }
    else if (m.t === "rec") { const r = recs.get(m.id); if (r) r._ev(m); }
    else if (m.t === "say") {
      const u = says.get(m.id); if (!u) return;
      if (m.ev === "start") { if (u.onstart) u.onstart({ type: "start" }); return; }
      says.delete(m.id); synth.speaking = says.size > 0;
      if (m.ev === "end") { if (u.onend) u.onend({ type: "end" }); }
      else if (u.onerror) u.onerror({ type: "error", error: m.error || "synthesis-failed" });
    }
    else if (m.t === "app") appFns.forEach(f => { try { f(m.ev, m); } catch (e) {} });
  };
  B.onmessage = onMsg;

  try { Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true, writable: true }); } catch (e) { try { window.speechSynthesis = synth; } catch (e2) {} }
  window.SpeechSynthesisUtterance = OdinUtterance;
  window.SpeechRecognition = OdinRec;
  if (typeof window.SpeechRecognitionPhrase !== "function") window.SpeechRecognitionPhrase = function (phrase, boost) { this.phrase = phrase; this.boost = boost == null ? 1 : boost; };
  window.ODIN_ANDROID = {
    info: ask("hello", { page: location.pathname }),
    print: title => send({ t: "print", title: title || document.title }),
    setup: () => send({ t: "setup" }),
    on: f => appFns.push(f)
  };
})();
