#!/usr/bin/env python3
"""Fluid's page tests (Playwright and Chromium). Build first: python3 web/build.py

1. The page: levels, Odin's 36 passages, a passage's choices; the microphone's status.
2. A sample reading by the pretend reader, from start to finish, with its score and marked words.
3. Practice with the microphone, through a stand-in on-device recognizer: the microphone check, reading, a misread word
   that Fluid says and has the reader say again, then praise and the rest of the passage; the score; "best today".
4. A one-minute reading (the minute made shorter for the test): the score counts words correct in the minute.
5. New passages: typed in (numbers become words), and written by a stand-in AI (web/tests/fake_ai.py); kept on the
   device; deleted. The AI's key is never kept.
6. Nothing about readers is kept: after a reload, no readings, and the page's storage holds only passages and the AI's name.
Pictures and the results go to FLUID_TEST_OUT (default: a folder in the system's temp directory). Lines starting FAIL fail.
"""
import http.server
import json
import os
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fake_ai

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get("FLUID_TEST_OUT") or tempfile.mkdtemp(prefix="fluid-test-"))
OUT.mkdir(parents=True, exist_ok=True)
fails = []


def check(ok, msg):
    print(("ok   " if ok else "FAIL ") + msg)
    if not ok:
        fails.append(msg)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: Quiet(*a, directory=str(ROOT / "dist"), **k))
threading.Thread(target=srv.serve_forever, daemon=True).start()
PAGE = f"http://127.0.0.1:{srv.server_port}/index.html"
AI = fake_ai.start(8095)

# A stand-in for the browser's on-device speech recognizer: window.__say(text) is what the reader says next.
FAKE_SR = """
(() => {
  class FakeRec {
    constructor() { this.lang = "en-US"; this.continuous = false; this.interimResults = false; this._t = ""; FakeRec.made++; }
    start() { FakeRec.live = this; setTimeout(() => { if (FakeRec.live === this && this.onstart) this.onstart({}); }, 40); }
    stop() { const me = this; setTimeout(() => { if (FakeRec.live === me) FakeRec.live = null; if (me.onend) me.onend({}); }, 30); }
    abort() { if (FakeRec.live === this) FakeRec.live = null; }
    static available() { return Promise.resolve("available"); }
  }
  FakeRec.prototype.processLocally = false;
  FakeRec.made = 0; FakeRec.live = null;
  window.SpeechRecognition = FakeRec;
  window.__said = [];
  window.__say = text => { const r = FakeRec.live; if (!r || !r.onresult) return false; r._t += " " + text; window.__said.push(text); r.onresult({ results: [[{ transcript: r._t }]] }); return true; };
  window.__listening = () => !!(FakeRec.live && FakeRec.live.onresult);
  window.__fluidQuiet = true;
})();
"""


def new_page(b, fake=True, speed=4, minute=1):
    c = b.new_context(viewport={"width": 412, "height": 900})
    p = c.new_page()
    p.on("pageerror", lambda e: errs.append(str(e)))
    p.route("**/*", lambda r: r.abort() if r.request.url.startswith("http") and "127.0.0.1" not in r.request.url else r.continue_())
    p.add_init_script(f"window.__fluidSimSpeed = {speed}; window.__fluidMinute = {minute};" + (FAKE_SR if fake else "window.__fluidQuiet = true;"))
    return c, p


def wait_step(p, step, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = p.evaluate("window.__fluid.state().reading")
        if r and r["step"] == step:
            return True
        p.wait_for_timeout(100)
    return False


def mic_ready(p):
    """Chromium isn't Google Chrome, so Fluid waits for "Check this browser", as a reader would press it."""
    p.wait_for_selector("header.top")
    p.wait_for_function("window.__fluid.state().speech !== 'checking'")
    if p.evaluate("window.__fluid.state().speech") == "manual":
        p.click("[data-a=check]")
    p.wait_for_function("window.__fluid.state().speech === 'available'")


def say_when_listening(p, text, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if p.evaluate("window.__listening()") and p.evaluate("t => window.__say(t)", text):
            return True
        p.wait_for_timeout(60)
    return False


errs = []
with sync_playwright() as pw:
    b = pw.chromium.launch()

    # 1. the page
    c, p = new_page(b, fake=False)
    p.goto(PAGE); p.wait_for_selector("header.top")
    st = p.evaluate("window.__fluid.state()")
    ps = p.evaluate("window.__fluid.passages()")
    check(st["version"] and len(ps) == 36 and sorted({x["band"] for x in ps}) == [0, 1, 2, 3, 4, 5], f"Fluid {st['version']} opens with Odin's 36 passages, kindergarten to grade 5")
    check(st["speech"] in ("manual", "none") and p.locator("#mic").count() == 1, f"the microphone's status shows ({st['speech']}: plain Chromium has no on-device speech)")
    p.click("[data-a=level][data-v='3']")
    check(p.locator(".pitem").count() == 6, "a level shows its 6 passages")
    p.click(".pitem >> nth=1"); p.wait_for_selector("#pick")
    check(p.locator("[data-a=read][data-kind=practice]").is_disabled() and not p.locator("[data-a=sample]").is_disabled(), "without the microphone, Practice waits and the sample reading is offered")
    p.screenshot(path=str(OUT / "1-passage.png"), full_page=True)

    # 2. a sample reading
    p.click("[data-a=sample]"); p.wait_for_selector("#fl [data-flx=go]"); p.click("#fl [data-flx=go]")
    check(wait_step(p, "done", 90), "the pretend reader reads the whole passage, and Fluid helps on the way")
    r = p.evaluate("window.__fluid.result()")
    check(r["finished"] and r["supplied"] == 1 and r["helped"] == 1 and "x" in r["marks"] and r["acc"] >= 95 and r["wcpm"] > 0,
          f"its score: {r['wcpm']} words correct per minute, {r['acc']}% (one word said for the reader, one misread fixed with help)")
    check(p.locator("#fl .fltext.marks .m-x").count() == 1 and p.locator("#fl .fltext.marks .m-s").count() == 1, "the passage shows which words were misread and which were said for the reader")
    p.screenshot(path=str(OUT / "2-sample-done.png"))
    p.click("#fl [data-flx=leave]")
    check(p.evaluate("window.__fluid.state().runs") == 0, "a sample reading isn't counted with the readings")
    c.close()

    # 3. practice with the microphone (a stand-in recognizer)
    c, p = new_page(b)
    p.goto(PAGE); mic_ready(p)
    check("Ready" in p.inner_text("#mic"), "with an on-device recognizer, the microphone is ready")
    p.click("[data-a=level][data-v='0']"); p.click(".pitem >> nth=0"); p.wait_for_selector("#pick")
    pid = p.evaluate("window.__fluid.state().open")
    words = p.evaluate("id => flPassageWords(id).map(w => w.n)", pid)
    p.click("[data-a=read][data-kind=practice]"); p.click("#fl [data-flx=go]")
    check(wait_step(p, "check") and say_when_listening(p, "i am ready to read") and wait_step(p, "read"), "the microphone check: the reader says “I am ready to read”, and the reading starts")
    k = 10
    ok = say_when_listening(p, " ".join(words[:k]))
    ok = ok and p.evaluate("t => window.__say(t)", "zebra " + words[k + 1])   # word k misread
    check(ok and wait_step(p, "help", 10), f"a misread word ({words[k]}) is caught as soon as the reader says the next word")
    check(p.evaluate("window.__fluid.state().reading.ptr") == k + 1, "Fluid says the word and waits for the reader to say it")
    check(say_when_listening(p, words[k]) and wait_step(p, "read", 10), "the reader says it right: praise, and the reading goes on from the next word")
    rest = words[k + 1:]
    say_when_listening(p, " ".join(rest[:15]))
    p.evaluate("t => window.__say(t)", " ".join(rest[15:]))
    check(wait_step(p, "done", 15), "the reader reads the rest, and the reading ends at the last word")
    r = p.evaluate("window.__fluid.result()")
    check(r["finished"] and r["helped"] == 1 and r["marks"][k] == "x" and r["correct"] == len(words) - 1 and r["acc"] == round(100 * (len(words) - 1) / len(words)),
          f"its score: {r['correct']} of {len(words)} words correct, {r['acc']}%, {r['wcpm']} words correct per minute")
    p.screenshot(path=str(OUT / "3-practice-done.png"))
    p.click("#fl [data-flx=leave]")
    check(p.evaluate("window.__fluid.state().runs") == 1 and "Readings so far" in p.inner_text("main") and "best today" in p.inner_text(".pitem >> nth=0"),
          "the reading is listed (until Fluid closes), with the best today on the passage")
    p.screenshot(path=str(OUT / "3-runs.png"), full_page=True)

    # 4. a one-minute reading (the minute is 5 seconds here)
    c.close(); c, p = new_page(b, minute=12)
    p.goto(PAGE); mic_ready(p)
    p.click("[data-a=level][data-v='2']"); p.click(".pitem >> nth=0")
    words = p.evaluate("id => flPassageWords(id).map(w => w.n)", p.evaluate("window.__fluid.state().open"))
    p.click("[data-a=read][data-kind=minute]"); p.click("#fl [data-flx=go]")
    wait_step(p, "check"); say_when_listening(p, "i am ready to read"); wait_step(p, "read")
    say_when_listening(p, " ".join(words[:30]))
    check(wait_step(p, "done", 15), "the minute ends the reading by itself")
    r = p.evaluate("window.__fluid.result()")
    check(r["kind"] == "minute" and r["secs"] == 60 and r["wcpm"] == 30 and r["correct"] == 30, f"the one-minute score is the words correct in the minute: {r['wcpm']}")
    p.click("#fl [data-flx=leave]")

    # 5. new passages
    p.click("[data-a=type]"); p.select_option("#fln-band", "1")
    p.fill("#fln-title", "Our Garden")
    p.fill("#fln-text", "We planted 12 seeds in our garden. " * 4 + "\n\n" + "We water them and watch them grow. " * 4)
    p.click("[data-a=psave]"); p.wait_for_timeout(200)
    added = [x for x in p.evaluate("window.__fluid.passages()") if x["added"]]
    text = p.evaluate("FL_BY_ID['A1-1'] && FL_BY_ID['A1-1'].text")
    check(added == [{"id": "A1-1", "band": 1, "title": "Our Garden", "added": True}] and "twelve seeds" in text and "12" not in text, "a typed-in passage is saved as A1-1, with numbers as words")
    check(p.locator(".pitem .tag").count() == 1 and p.evaluate("window.__fluid.state().open") == "A1-1", "it's in its level's list, marked added")
    p.click("#ai-details summary"); p.select_option("#ai-provider", "openai")
    p.fill("#ai-url", "http://127.0.0.1:8095/v1"); p.fill("#ai-model", "stand-in"); p.fill("#ai-key", "sk-test-secret-1234"); p.click("[data-a=aisave]")
    p.fill("#fln-topic", "frogs in a pond"); p.select_option("#fln-band", "2"); p.click("[data-a=write]")
    p.wait_for_selector("#fln-text", timeout=20000)
    req = json.loads(urllib.request.urlopen("http://127.0.0.1:8095/requests").read())[-1]
    check(req["key"] == "sk-test-secret-1234" and "frogs in a pond" in json.dumps(req["body"]) and "grade 2" in json.dumps(req["body"]), "the AI is asked for a grade 2 passage about the topic, with the key typed in")
    p.click("[data-a=psave]"); p.wait_for_timeout(200)
    check(p.evaluate("FL_BY_ID['A2-1'] && FL_BY_ID['A2-1'].source").startswith("AI: "), "the AI's passage is saved as A2-1")
    p.screenshot(path=str(OUT / "5-added.png"), full_page=True)
    store = p.evaluate("JSON.stringify(Object.assign({}, localStorage))")
    check("sk-test-secret" not in store and "fluid.ai" in store, "the AI's name is kept on the device, never its key")

    # 6. nothing about readers is kept
    p.reload(); p.wait_for_selector("header.top")
    keys = p.evaluate("Object.keys(localStorage).sort()")
    check(p.evaluate("window.__fluid.state().runs") == 0 and keys == ["fluid.ai", "fluid.passages"] and len([x for x in p.evaluate("window.__fluid.passages()") if x["added"]]) == 2,
          f"after a reload: no readings; the device keeps only the added passages and the AI's name ({keys})")
    check(p.evaluate("window.__fluid.ai().hasKey") is False, "and the key is gone")
    p.click("[data-a=level][data-v='1']"); p.click(".pitem >> text=Our Garden")
    p.click("[data-a=pdel][data-id='A1-1']"); p.click("[data-a=pdelyes]")
    check("A1-1" not in [x["id"] for x in p.evaluate("window.__fluid.passages()")], "an added passage can be deleted")
    c.close()
    b.close()

AI.shutdown()
print("page errors:", errs[:3])
if errs:
    fails.append("page errors")
print(f"pictures in {OUT}")
print("ALL PASS" if not fails else f"{len(fails)} FAILED")
sys.exit(1 if fails else 0)
