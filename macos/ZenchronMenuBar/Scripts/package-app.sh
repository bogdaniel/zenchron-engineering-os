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
mkdir -p "$APP_PATH/Contents/MacOS"
install -m 755 "$PACKAGE_DIR/.build/release/zenchron-menubar" "$APP_PATH/Contents/MacOS/zenchron-menubar"
cat > "$APP_PATH/Contents/Info.plist" <<'PLIST'
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
plutil -lint "$APP_PATH/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
printf 'Packaged %s\n' "$APP_PATH"
