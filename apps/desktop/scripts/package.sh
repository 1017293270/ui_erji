#!/usr/bin/env bash
# Builds the macOS installer for colleagues: pnpm desktop:package
#
#  - The speech models (~250 MB) go inside the app, so nobody downloads them from GitHub.
#    They are copied from this Mac's EchoMind data folder (the app downloads them on first use)
#    and checked against the transcriber's sha256 pins before packaging.
#  - Signed ad hoc ("-") and without the hardened runtime: there is no Developer ID yet, so the
#    app cannot be notarized and colleagues allow it once in System Settings → Privacy & Security.
#  - The release build talks only to the EchoMind server and carries no secrets.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(cd ../.. && pwd)
TAURI=src-tauri
MODELS_SRC=${ECHOMIND_MODELS_SRC:-"$HOME/Library/Application Support/com.evanbyte.echomind/models"}
ARCH=aarch64-apple-darwin

for bin in echomind-capture echomind-transcribe; do
  [ -x "$TAURI/binaries/$bin-$ARCH" ] || { echo "缺少 $bin：先运行 pnpm capture:build 和 pnpm transcriber:build。" >&2; exit 1; }
done

echo "== 准备模型 =="
rm -rf "$TAURI/resources/models"
mkdir -p "$TAURI/resources/models"
for id in asr vad segmentation embedding; do
  [ -f "$MODELS_SRC/$id/.ready" ] || { echo "本机还没有下载好模型 $id：先在 EchoMind 里转写一次，或者设置 ECHOMIND_MODELS_SRC。" >&2; exit 1; }
  cp -R "$MODELS_SRC/$id" "$TAURI/resources/models/$id"
done
"$TAURI/binaries/echomind-transcribe-$ARCH" models --models-dir "$TAURI/resources/models" \
  | node -e 'process.exit(JSON.parse(require("fs").readFileSync(0, "utf8")).ready ? 0 : 1)' \
  || { echo "模型校验没通过，请在 EchoMind 里重新下载模型。" >&2; exit 1; }
du -sh "$TAURI/resources/models"

echo "== 构建 =="
# No .env.local in the build: release builds never read it, but keep secrets out of the way regardless.
pnpm tauri build --config "$TAURI/tauri.package.conf.json"

APP="$TAURI/target/release/bundle/macos/EchoMind.app"
DMG=$(ls -t "$TAURI"/target/release/bundle/dmg/*.dmg | head -1)

echo "== 检查 =="
for id in asr vad segmentation embedding; do
  [ -f "$APP/Contents/Resources/models/$id/.ready" ] || { echo "安装包里缺少模型 $id。" >&2; exit 1; }
done
codesign --verify --deep --strict "$APP"
# The real secret values, searched for byte for byte and never printed.
ENV_FILE=.env.local
for key in FEISHU_APP_SECRET DEEPSEEK_API_KEY; do
  value=$(sed -n -E "s/^(export )?$key[[:space:]]*=[[:space:]]*['\"]?([^'\" #]+).*/\2/p" "$ENV_FILE" 2>/dev/null | tail -1)
  [ -n "$value" ] || continue
  if grep -a -q -F -r -- "$value" "$APP"; then
    echo "安装包里找到了 $key 的值，停止。" >&2
    exit 1
  fi
  echo "安装包里没有 $key"
done
mkdir -p "$ROOT/dist"
OUT="$ROOT/dist/$(basename "$DMG")"
cp "$DMG" "$OUT"
echo "安装包：$OUT（$(du -h "$OUT" | cut -f1)）"
