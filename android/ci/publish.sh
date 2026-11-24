#!/usr/bin/env bash
# Puts the app and the check's results on the android-build branch, where
# https://github.com/PurpleNinjaRadish/Fluid/raw/android-build/fluid-android.apk finds the app (the README's and the Tools
# Hub's link), as for DI-ana and Odin. Run by .github/workflows/android.yml.
set -eu
P=$(mktemp -d)
cp android/app/build/outputs/apk/release/app-release.apk "$P/fluid-android.apk" 2>/dev/null || true
cp build-log.txt "$P/" 2>/dev/null || true
if [ -d out ]; then cp -r out "$P/check"; fi
{
  echo "commit: $GITHUB_SHA"
  echo "run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "build: ${BUILD_RESULT:-}"
  echo "emulator check: ${CHECK_RESULT:-}"
} > "$P/BUILD.txt"
(
  cd "$P"
  git init -q -b android-build
  git add -A
  git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -qm "Fluid for Android: build of ${GITHUB_SHA}"
  git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" HEAD:android-build
)
