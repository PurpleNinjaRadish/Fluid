#!/usr/bin/env python3
"""Draws Fluid's icons (web/icons/*.png) from one picture: lines of a passage on a page, with a wave under them (reading that
flows), on Fluid's blue. Needs Playwright (python3 -m pip install playwright). Run when the icon changes."""
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[1] / "web/icons"
def svg(pad):   # pad: room around the picture (a maskable icon keeps its middle 80% safe)
    s = 100 - 2 * pad
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">
  <rect width="100" height="100" fill="#1D6A96"/>
  <g transform="translate({pad} {pad}) scale({s / 100})">
    <rect x="20" y="18" width="60" height="64" rx="7" fill="#fff"/>
    <g stroke="#1D6A96" stroke-width="5" stroke-linecap="round"><path d="M30 33h40"/><path d="M30 45h30"/></g>
    <path d="M30 62c6-9 12-9 18 0s12 9 18 0" fill="none" stroke="#2FA36B" stroke-width="5.5" stroke-linecap="round"/>
  </g></svg>"""
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as pw:
    b = pw.chromium.launch(); pg = b.new_page()
    for name, size, pad in (("icon-192.png", 192, 4), ("icon-512.png", 512, 4), ("icon-maskable-512.png", 512, 14), ("apple-touch-icon.png", 180, 6)):
        pg.set_viewport_size({"width": size, "height": size})
        pg.set_content(f"<html><body style='margin:0'>{svg(pad)}</body></html>")
        pg.screenshot(path=str(OUT / name), omit_background=False)
    b.close()
print("icons in", OUT)
