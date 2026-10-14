#!/usr/bin/env bash
# Builds echomind-transcribe in release mode and installs it as a Tauri sidecar.
#
# The app runs it as a separate process (`run <dir> --json`): onnxruntime aborts the
# whole process on a damaged model, and that must not take the app down.
#
# Builds the host architecture; on macOS it also builds x86_64 and a universal binary
# when that Rust target is installed (`rustup target add x86_64-apple-darwin`).
#
# Output: apps/desktop/src-tauri/binaries/echomind-transcribe-<target-triple>[.exe]
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"
NAME="echomind-transcribe"
IDENTIFIER="com.evanbyte.echomind.transcribe"
SIDECAR_DIR="$REPO_ROOT/apps/desktop/src-tauri/binaries"
export PATH="$HOME/.cargo/bin:$PATH"

mkdir -p "$SIDECAR_DIR"
host="$(rustc -vV | sed -n 's/^host: //p')"

install() {
  local source="$1" triple="$2" ext="${3:-}"
  local target="$SIDECAR_DIR/$NAME-$triple$ext"
  rm -f "$target"
  cp "$source" "$target"
  if [[ "$(uname)" == "Darwin" ]]; then
    codesign --sign - --force --identifier "$IDENTIFIER" "$target"
  fi
  echo "installed $target"
}

if [[ "$(uname)" == "Darwin" ]]; then
  export MACOSX_DEPLOYMENT_TARGET=14.2
  cargo build --release --bin "$NAME" --target aarch64-apple-darwin
  install "target/aarch64-apple-darwin/release/$NAME" aarch64-apple-darwin
  if rustup target list --installed | grep -qx x86_64-apple-darwin; then
    cargo build --release --bin "$NAME" --target x86_64-apple-darwin
    install "target/x86_64-apple-darwin/release/$NAME" x86_64-apple-darwin
    lipo -create -output "target/$NAME-universal" \
      "target/aarch64-apple-darwin/release/$NAME" "target/x86_64-apple-darwin/release/$NAME"
    install "target/$NAME-universal" universal-apple-darwin
  else
    echo "note: x86_64-apple-darwin is not installed; built for Apple silicon only" >&2
  fi
else
  ext=""
  [[ "$host" == *windows* ]] && ext=".exe"
  cargo build --release --bin "$NAME"
  install "target/release/$NAME$ext" "$host" "$ext"
fi
