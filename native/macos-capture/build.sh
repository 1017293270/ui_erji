#!/usr/bin/env bash
# Builds echomind-capture, ad-hoc signs it and installs it as a Tauri sidecar.
#
# `swift build --arch arm64 --arch x86_64` needs XCBuild (full Xcode only), so with Command Line
# Tools we build each architecture with --triple and merge them with lipo. If the x86_64 build
# fails the script falls back to arm64 only.
#
# Output:
#   .build/dist/echomind-capture                                         (universal or arm64)
#   apps/desktop/src-tauri/binaries/echomind-capture-aarch64-apple-darwin
#   apps/desktop/src-tauri/binaries/echomind-capture-x86_64-apple-darwin   (universal build only)
#   apps/desktop/src-tauri/binaries/echomind-capture-universal-apple-darwin (universal build only)
set -euo pipefail

cd "$(dirname "$0")"
PKG_DIR="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"
NAME="echomind-capture"
IDENTIFIER="com.evanbyte.echomind.capture"
MIN_MACOS="14.2"
DIST="$PKG_DIR/.build/dist"
SIDECAR_DIR="$REPO_ROOT/apps/desktop/src-tauri/binaries"

sign() {
  codesign --sign - --force --identifier "$IDENTIFIER" "$1"
}

mkdir -p "$DIST" "$SIDECAR_DIR"

universal=0
# x86_64 first so that .build/release ends up pointing at the native arm64 build.
if swift build -c release --triple "x86_64-apple-macosx$MIN_MACOS"; then
  universal=1
else
  echo "warning: x86_64 build failed, producing an arm64-only binary" >&2
fi
swift build -c release --triple "arm64-apple-macosx$MIN_MACOS"

ARM64_BIN="$PKG_DIR/.build/arm64-apple-macosx/release/$NAME"
X86_64_BIN="$PKG_DIR/.build/x86_64-apple-macosx/release/$NAME"

rm -f "$DIST/$NAME"
if [[ $universal == 1 ]]; then
  lipo -create -output "$DIST/$NAME" "$ARM64_BIN" "$X86_64_BIN"
else
  cp "$ARM64_BIN" "$DIST/$NAME"
fi
sign "$DIST/$NAME"
sign "$ARM64_BIN"

install_sidecar() {
  local triple="$1" arch="$2"
  local target="$SIDECAR_DIR/$NAME-$triple"
  rm -f "$target"
  if [[ -n "$arch" ]]; then
    lipo -thin "$arch" -output "$target" "$DIST/$NAME"
  else
    cp "$DIST/$NAME" "$target"
  fi
  sign "$target"
  echo "installed $target"
}

if [[ $universal == 1 ]]; then
  install_sidecar aarch64-apple-darwin arm64
  install_sidecar x86_64-apple-darwin x86_64
  install_sidecar universal-apple-darwin ""
else
  install_sidecar aarch64-apple-darwin ""
fi

echo
lipo -info "$DIST/$NAME"
codesign --display --verbose=2 "$DIST/$NAME" 2>&1 | grep -E '^(Identifier|Format|Signature|Info.plist)' || true
