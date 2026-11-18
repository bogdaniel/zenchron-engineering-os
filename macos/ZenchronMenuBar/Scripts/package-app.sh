#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
PACKAGE_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
OUTPUT_DIR=${1:-"$PACKAGE_DIR/.build/packaged"}
APP_PATH="$OUTPUT_DIR/Zenchron Menu Bar.app"

if [[ -e "$APP_PATH" ]]; then
  printf 'Refusing to replace existing app bundle: %s\n' "$APP_PATH" >&2
  exit 1
fi

swift build --package-path "$PACKAGE_DIR" --configuration release
mkdir -p "$OUTPUT_DIR"
STAGING_DIR=$(mktemp -d "$OUTPUT_DIR/.zenchron-menubar.XXXXXX")
trap 'rm -rf -- "$STAGING_DIR"' EXIT
STAGED_APP="$STAGING_DIR/Zenchron Menu Bar.app"
mkdir -p "$STAGED_APP/Contents/MacOS"
install -m 755 "$PACKAGE_DIR/.build/release/zenchron-menubar" "$STAGED_APP/Contents/MacOS/zenchron-menubar"
cat > "$STAGED_APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>zenchron-menubar</string>
  <key>CFBundleIdentifier</key>
  <string>com.zenchron.engineering.menubar</string>
  <key>CFBundleName</key>
  <string>Zenchron Menu Bar</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST
plutil -lint "$STAGED_APP/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$STAGED_APP"
codesign --verify --deep --strict "$STAGED_APP"
mv -n "$STAGED_APP" "$APP_PATH"
if [[ -e "$STAGED_APP" ]]; then
  printf 'Refusing to replace existing app bundle: %s\n' "$APP_PATH" >&2
  exit 1
fi
printf 'Packaged %s\n' "$APP_PATH"
