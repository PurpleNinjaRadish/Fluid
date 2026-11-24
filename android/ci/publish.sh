#!/usr/bin/env bash
# Puts the app and the check's results on the android-build branch, and (when the build and the check passed) the app on
# the "latest" release, where https://github.com/PurpleNinjaRadish/Fluid/releases/latest/download/fluid-android.apk finds
# it and the Tools Hub shows it. Run by .github/workflows/android.yml.
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
VERSION=$(cat VERSION)
(
  cd "$P"
  git init -q -b android-build
  git add -A
  git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -qm "Fluid for Android: build of ${GITHUB_SHA}"
  git push -qf "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" HEAD:android-build
)
if [ "${BUILD_RESULT:-}" = "success" ] && [ "${CHECK_RESULT:-}" = "success" ] && [ -f "$P/fluid-android.apk" ]; then
  gh release delete latest --yes --cleanup-tag 2>/dev/null || true
  gh release create latest "$P/fluid-android.apk" --target "$GITHUB_SHA" --title "Fluid ${VERSION} for Android (latest build)" \
    --notes "The newest build of Fluid for Android, from ${GITHUB_SHA:0:7}. It passed the emulator check. Install fluid-android.apk on an Android phone or tablet (Android 12 or newer for the microphone). Signed with Fluid's test key; for a school or district, build with its own key (see the README)."
fi
