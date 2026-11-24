#!/usr/bin/env python3
"""Build Fluid's page. Run from anywhere: python3 web/build.py   (needs Python 3.9+)

dist/index.html                              the web copy for GitHub Pages (and Odin-2/fluid/)
android/app/src/main/assets/web/index.html   the same page inside the Android app, with the fonts from the app itself
                                             (so the app never calls the internet for them)
Odin's fluency practice comes from odin/ (tools/sync_odin.py).
"""
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
src = lambda f: (WEB / "src" / f).read_text(encoding="utf-8")
odin = lambda f: (ROOT / "odin" / f).read_text(encoding="utf-8")
SOURCE = json.loads((ROOT / "odin/SOURCE.json").read_text(encoding="utf-8"))
ENGINE = ["android.js", "fluency_passages.js", "fluency.js", "ai.js"]
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()

info = {"version": VERSION, "odin": {"odinVersion": SOURCE["odinVersion"], "odinCommit": SOURCE.get("odinCommit", "")}}
engine = "\n".join(odin(f) for f in ENGINE)
head = src("head.html").replace("/*CSS*/", odin("fluency.css") + "\n" + src("fluid.css"))
# In the Android app, the app's bridge is window.FluidAndroid; Odin's speech shim (odin/android.js) looks for OdinAndroid.
alias = "<script>if (window.FluidAndroid && !window.OdinAndroid) window.OdinAndroid = window.FluidAndroid;</script>\n"
page = (head + '<div id="app"></div>\n' + alias + f"<script>\nconst FLUID = {json.dumps(info)};\n{engine}\n</script>\n<script>\n{src('fluid.js')}\n</script>\n</body>\n</html>\n")

dist = ROOT / "dist"
dist.mkdir(exist_ok=True)
(dist / "index.html").write_text(page, encoding="utf-8")
(dist / "icons").mkdir(exist_ok=True)
for f in (WEB / "icons").glob("*.png"):
    shutil.copyfile(f, dist / "icons" / f.name)
manifest = {"name": "Fluid · Fluency reading practice", "short_name": "Fluid",
            "description": "Fluency reading practice: read a passage out loud, and Fluid listens on the device, helps with missed words and shows words correct per minute. Nothing about readers is kept.",
            "id": "./", "start_url": "./", "scope": "./", "display": "standalone", "background_color": "#F2F5F8", "theme_color": "#1D6A96",
            "icons": [{"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"}, {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
                      {"src": "icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}]}
(dist / "manifest.webmanifest").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")

# inside the Android app: no "install this page" parts, and the fonts from the app
app = re.sub(r"<!--app-->.*?<!--/app-->\n?", "", page, flags=re.S)
app = re.sub(r"<!--fonts-->.*?<!--/fonts-->", '<link rel="stylesheet" href="fonts/fonts.css">', app, flags=re.S)
assert "fonts.googleapis" not in app and "manifest" not in app
assets = ROOT / "android/app/src/main/assets/web"
if assets.parent.parent.exists():
    (assets / "fonts").mkdir(parents=True, exist_ok=True)
    (assets / "index.html").write_text(app, encoding="utf-8")
    for f in (ROOT / "odin/fonts").iterdir():
        shutil.copyfile(f, assets / "fonts" / f.name)
print(f"Fluid {VERSION} with Odin {SOURCE['odinVersion']}'s fluency practice: dist/index.html {len(page.encode()) // 1024} KB")
