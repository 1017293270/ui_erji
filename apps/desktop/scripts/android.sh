#!/usr/bin/env bash
# Builds the Android app for arm64 phones: pnpm android:build [--release]
#
#  - Needs Android Studio's SDK, NDK 27 and JDK 17. The defaults below are where Android Studio
#    and Homebrew put them on a Mac; set ANDROID_HOME, NDK_HOME or JAVA_HOME to use others.
#  - The speech models (~270 MB) go inside the package, from src-tauri/resources/models. When
#    that folder is empty they are copied from this Mac's EchoMind data folder, as
#    scripts/package.sh does. The app unpacks them on first run.
#  - The first build downloads sherpa-onnx's Android libraries from GitHub.
#  - A debug build is installed on the phone or emulator adb sees, if there is one.
#  - A release build comes out unsigned: it needs the company's signing key before it can be
#    handed out, and that key is not set up yet.
set -euo pipefail
cd "$(dirname "$0")/.."
export ANDROID_HOME=${ANDROID_HOME:-"$HOME/Library/Android/sdk"}
export NDK_HOME=${NDK_HOME:-"$ANDROID_HOME/ndk/27.3.13750724"}
export JAVA_HOME=${JAVA_HOME:-"/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"}
MODELS=src-tauri/resources/models
MODELS_SRC=${ECHOMIND_MODELS_SRC:-"$HOME/Library/Application Support/com.evanbyte.echomind/models"}
OUT=src-tauri/gen/android/app/build/outputs/apk/universal

for dir in "$ANDROID_HOME" "$NDK_HOME" "$JAVA_HOME"; do
  [ -d "$dir" ] || { echo "找不到 $dir：先装好 Android Studio（含 NDK 27）和 JDK 17，或者设置对应的环境变量。" >&2; exit 1; }
done

for id in asr vad segmentation embedding; do
  [ -f "$MODELS/$id/.ready" ] && continue
  [ -f "$MODELS_SRC/$id/.ready" ] || { echo "本机还没有下载好模型 $id：先在桌面版 EchoMind 里转写一次，或者设置 ECHOMIND_MODELS_SRC。" >&2; exit 1; }
  mkdir -p "$MODELS"
  rm -rf "$MODELS/$id"
  cp -R "$MODELS_SRC/$id" "$MODELS/$id"
done

if [ "${1:-}" = "--release" ]; then
  pnpm tauri android build --apk --target aarch64
  ls -lh "$OUT"/release/*.apk
else
  pnpm tauri android build --debug --apk --target aarch64
  APK="$OUT/debug/app-universal-debug.apk"
  ls -lh "$APK"
  ADB="$ANDROID_HOME/platform-tools/adb"
  if "$ADB" devices | sed 1d | grep -qw device; then
    "$ADB" install -r "$APK"
  fi
fi
