#!/usr/bin/env bash
set -euo pipefail
# Never use shell tracing here: signing material must stay out of logs.
set +x
cd "$(dirname "$0")/.."
APP_DIR="$PWD"
REPO_DIR="$(cd .. && pwd -P)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
SIGNING_DIR="${KIFUMATE_SIGNING_DIR:-$HOME/.config/kifumate/android-keystore}"
OUT_DIR="${KIFUMATE_RELEASE_DIR:-$HOME/kifumate-releases}"
export KIFUMATE_CREDENTIALS="$SIGNING_DIR/credentials.json"
# The key that signed every distributed APK; never generate a replacement.
if [[ ! -f "$KIFUMATE_CREDENTIALS" ]]; then
  echo "Missing $KIFUMATE_CREDENTIALS; restore the signing backup (see README). No key was created." >&2
  exit 1
fi
SIGNING_DIR="$(cd "$SIGNING_DIR" && pwd -P)"
case "$SIGNING_DIR/" in "$REPO_DIR/"*) echo 'Signing directory must be outside the repository' >&2; exit 1;; esac
chmod 700 "$SIGNING_DIR"
chmod 600 "$KIFUMATE_CREDENTIALS"
[[ -d "$ANDROID_HOME/platforms" ]] || { echo "Android SDK missing at $ANDROID_HOME" >&2; exit 1; }

VERSION="$(node -p 'require("./app.json").expo.version')"
VERSION_CODE="$(APP_VARIANT=production npx expo config --json | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0)).android.versionCode))')"
APK="$OUT_DIR/kifumate-$VERSION-$VERSION_CODE.apk"
[[ ! -e "$APK" ]] || { echo "$APK already exists; bump expo.version in app.json first." >&2; exit 1; }

# Release config and the production API; environment variables take precedence over .env.local.
export APP_VARIANT=production
export EXPO_PUBLIC_ANALYSIS_URL=https://kifumate-api.quarterlambda.com
# CI avoids interactive prompts. Native files are disposable; app.json / app.config.ts remain the source of truth.
CI=1 npx expo prebuild --platform android --clean --no-install
(
  cd android
  ./gradlew --no-daemon --max-workers "${KIFUMATE_GRADLE_WORKERS:-2}" \
    --init-script "$APP_DIR/scripts/release-signing.gradle" :app:assembleRelease
)
mkdir -p "$OUT_DIR"
cp android/app/build/outputs/apk/release/app-release.apk "$APK"
APKSIGNER="$(find "$ANDROID_HOME/build-tools" -mindepth 2 -maxdepth 2 -name apksigner | sort -V | tail -1)"
"$APKSIGNER" verify --verbose --print-certs "$APK"
(cd "$OUT_DIR" && sha256sum "$(basename "$APK")" | tee "$(basename "$APK").sha256")
echo "APK: $APK"
