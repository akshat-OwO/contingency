#!/bin/sh
set -eu
out=${1:?Usage: build.sh OUTPUT_DIRECTORY}
mkdir -p "$out/PrivateTextFixture.app"
xcrun --sdk iphonesimulator clang -fobjc-arc -target arm64-apple-ios26.0-simulator \
  -isysroot "$(xcrun --sdk iphonesimulator --show-sdk-path)" -framework UIKit \
  packages/cli/prototypes/ios/private-text/fixture.m -o "$out/PrivateTextFixture.app/PrivateTextFixture"
cat > "$out/PrivateTextFixture.app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PrivateTextFixture</string>
<key>CFBundleIdentifier</key><string>dev.contingency.private-text-spike</string>
<key>CFBundleName</key><string>PrivateTextFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>UILaunchScreen</key><dict/>
</dict></plist>
PLIST
