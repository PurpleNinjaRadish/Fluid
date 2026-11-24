#!/usr/bin/env python3
"""Takes the README's pictures (docs/pictures/*.png) from the page: choosing a passage, a sample reading in progress (the
voice helping with a word), and its score. Build first (python3 web/build.py). Needs Playwright."""
import http.server
import threading
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/pictures"
OUT.mkdir(parents=True, exist_ok=True)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: Quiet(*a, directory=str(ROOT / "dist"), **k))
threading.Thread(target=srv.serve_forever, daemon=True).start()
with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 412, "height": 860}, device_scale_factor=2)
    p.add_init_script("window.__fluidSimSpeed = 1.6; window.__fluidQuiet = true;")
    p.goto(f"http://127.0.0.1:{srv.server_port}/index.html"); p.wait_for_selector("header.top")
    p.evaluate("window.__fluid.speech('available')")
    p.click("[data-a=level][data-v='2']"); p.click(".pitem >> nth=1"); p.wait_for_selector("#pick")
    p.evaluate("document.querySelector('.levels').scrollIntoView()")
    p.screenshot(path=str(OUT / "1-choose.png"))
    p.click("[data-a=sample]"); p.click("#fl [data-flx=go]")
    t0 = time.time()
    while time.time() - t0 < 120:
        r = p.evaluate("window.__fluid.state().reading")
        if r and r["step"] == "help":
            break
        p.wait_for_timeout(50)
    p.wait_for_timeout(150)
    p.screenshot(path=str(OUT / "2-reading.png"))
    while time.time() - t0 < 240:
        r = p.evaluate("window.__fluid.state().reading")
        if r and r["step"] == "done":
            break
        p.wait_for_timeout(200)
    p.wait_for_timeout(300)
    p.screenshot(path=str(OUT / "3-score.png"))
    b.close()
print("pictures in", OUT)
