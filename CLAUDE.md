# Fluid: notes for working on this repository

Fluid is fluency reading practice (a web page and an Android app), built from Odin's fluency practice. Odin is in
github.com/PurpleNinjaRadish/project-cerabus (Project Cerberus). Fluid stands alone: no sign-in, no server.

## Fluid and Odin
- `odin/` is a copy of Odin's files (`page-src/src/fluency_passages.js`, `fluency.js`, `ai.js`, `android.js`,
  `fluency.css`, `public/fonts`). Never edit it here: change Odin, then run `python3 tools/sync_odin.py <odin checkout>`,
  rebuild (`python3 web/build.py`), test, and commit both repositories.
- The reading screen in `web/src/fluid.js` is adapted from Odin's `page-src/src/ui_fluency.js`; `FluidBridge.java` is
  Odin's `OdinBridge.java` with Fluid's names and the "ai" message. Bring over Odin's changes to how it listens and helps.
- `odin/SOURCE.json` records the Odin version and commit the copy came from.

## Standing rules (from the project owner)
- Student data is never uploaded online. Fluid keeps nothing about readers: no names, no sign-in; a session's readings
  live in memory only. The device keeps only added passages and which AI was chosen (never a key).
- Speech only with an on-device recognizer (processLocally in Chrome; Android's on-device recognizer in the app).
- The AI is told only the level, the kind of text and the topic.
- Research cited must be from the last 5 years; no dyslexia studies.
- Commits: author "Claude <noreply@anthropic.com>"; never put the owner's email anywhere.

## The web copy
- GitHub Pages here (`.github/workflows/pages.yml`, once Pages is on), and a copy in the Odin-2 repository's `fluid/`
  folder (purpleninjaradish.github.io/Odin-2/fluid/): copy `dist/` there with each release.
- The Tools Hub (github.com/PurpleNinjaRadish/Github.io) links the web version and the APK on the android-build branch.

## Checks
- `python3 web/tests/test_fluid.py` (Playwright and Chromium; it starts a stand-in AI on port 8095).
- CI: `.github/workflows/pages.yml` (page tests, then GitHub Pages) and `android.yml` (app build, emulator check,
  and the app and the check's results on the android-build branch).
