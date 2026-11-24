#!/usr/bin/env python3
"""Copy the parts of Odin that Fluid shares into odin/, so both read and score the same way.

    python3 tools/sync_odin.py /path/to/project-cerabus

Odin (github.com/PurpleNinjaRadish/project-cerabus, Project Cerberus) is the only place these files are edited:
its fluency passages and scoring (fluency_passages.js, fluency.js), its AI helpers (ai.js), the Android speech shim
(android.js), the reading screen's styles (fluency.css) and its fonts. Run this after an Odin change to any of them, then
rebuild Fluid (python3 web/build.py) and run its tests. odin/SOURCE.json records the Odin version and commit.
"""
import hashlib
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
DEST = HERE / "odin"
# Kept in this order: later files use earlier ones. android.js does nothing outside the Android app.
ENGINE = ["android.js", "fluency_passages.js", "fluency.js", "ai.js"]
OTHER = ["fluency.css"]
FONTS = "public/fonts"


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    odin = Path(sys.argv[1]).resolve()
    src = odin / "page-src/src"
    if not (src / "fluency.js").is_file():
        sys.exit(f"{odin} doesn't look like Odin's repository (no page-src/src/fluency.js)")
    DEST.mkdir(exist_ok=True)
    files = {}
    for f in ENGINE + OTHER:
        shutil.copyfile(src / f, DEST / f)
        files[f] = "page-src/src/" + f
    fonts = DEST / "fonts"
    if fonts.exists():
        shutil.rmtree(fonts)
    fonts.mkdir()
    for f in sorted((odin / FONTS).iterdir()):
        if f.suffix in (".woff2", ".css", ".txt"):
            shutil.copyfile(f, fonts / f.name)
            files["fonts/" + f.name] = FONTS + "/" + f.name
    version = (src / "engine.js").read_text(encoding="utf-8").split('const ODIN_VERSION = "', 1)[1].split('"', 1)[0]
    try:
        commit = subprocess.run(["git", "-C", str(odin), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
        dirty = bool(subprocess.run(["git", "-C", str(odin), "status", "--porcelain", "page-src/src", FONTS], capture_output=True, text=True).stdout.strip())
    except Exception:
        commit, dirty = "", True
    source = {
        "odinVersion": version,
        "odinCommit": commit + (" (with changes not yet committed)" if dirty and commit else ""),
        "copied": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "files": {k: {"from": v, "sha256": hashlib.sha256((DEST / k).read_bytes()).hexdigest()} for k, v in sorted(files.items())},
    }
    (DEST / "SOURCE.json").write_text(json.dumps(source, indent=1) + "\n", encoding="utf-8")
    print(f"Copied Odin {version} ({commit[:10] or 'no git'}): {len(files)} files into odin/")


if __name__ == "__main__":
    main()
