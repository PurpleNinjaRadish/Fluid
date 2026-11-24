#!/usr/bin/env python3
"""Reads what the emulator check saw (out/report.txt, out/crash.txt, out/fake-ai.log) and says ok or FAIL for each part.
Exits 1 if anything failed."""
import json, re, sys
from pathlib import Path

OUT = Path(sys.argv[1])
rep = {}
for line in (OUT / "report.txt").read_text().splitlines() if (OUT / "report.txt").exists() else []:
    _, k, v = re.sub(r" \([^()]*\)$", "", line).split(" ", 2)   # Android adds the page's place in brackets
    try: rep[k] = json.loads(v)
    except ValueError: rep[k] = v
crash = (OUT / "crash.txt").read_text().strip() if (OUT / "crash.txt").exists() else ""
lines, fails = [], 0
def check(ok, msg):
    global fails
    lines.append(("ok   " if ok else "FAIL ") + msg); fails += not ok
h, sp, vo, sa, ai, li = rep.get("hello", {}), rep.get("speech", {}), rep.get("voice", []), rep.get("sample", {}), rep.get("ai", {}), rep.get("listen", [])
check(h.get("android") and h.get("bridge") and h.get("shim") and (h.get("info") or {}).get("app", "").startswith(h.get("version", "?")), f"Fluid opens in the app, with its bridge to Android's speech: {h}")
check(sp.get("status") not in (None, "checking", "none"), f"Android answered whether it can recognize speech on the device: {sp}")
check(isinstance(vo, list) and ("end" in vo or any(str(x).startswith("error") for x in vo)) and "timeout" not in vo, f"the device's voice speaks through the app: {vo}")
check(sa.get("step") == "done" and sa.get("finished") and sa.get("wcpm", 0) > 0, f"a sample reading runs from start to finish in the app: {sa}")
check(ai.get("words", 0) >= 20 and not ai.get("error"), f"the app called the stand-in AI and a passage came back: {ai}")
check(isinstance(li, list) and li[-1:] == ["end"] and "throw" not in li, f"a listening session starts and ends cleanly (on the emulator, Android may have no English speech pack): {li}")
mine = "\n".join(l for l in crash.splitlines() if "purpleninjaradish.fluid" in l)
check(not mine, "the app never crashed" + ("" if not mine else ": " + mine[:300]))
(OUT / "check.txt").write_text("\n".join(lines) + "\n" + ("ALL EMULATOR CHECKS PASSED\n" if not fails else f"{fails} FAILED\n"))
print("\n".join(lines))
sys.exit(1 if fails else 0)
