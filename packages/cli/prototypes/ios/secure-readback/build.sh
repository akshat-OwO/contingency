#!/bin/sh
# Build outside the repository. Nothing here enters the shipped CLI.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
out=${1:?Usage: build.sh OUTPUT_DIRECTORY}
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
target=arm64-apple-ios26.0-simulator
mkdir -p "$out/SecureReadbackFixture.app"
xcrun clang -O2 -Wall -Wextra -fobjc-arc -framework Foundation \
  "$here/hid-type.m" -o "$out/hid-type"
xcrun --sdk iphonesimulator clang -dynamiclib -O2 -Wall -Wextra -fobjc-arc \
  -target "$target" -isysroot "$sdk" -framework Foundation -framework UIKit \
  "$here/readback.m" -o "$out/readback.dylib"
xcrun --sdk iphonesimulator swiftc -parse-as-library -target "$target" -sdk "$sdk" \
  "$here/../private-text/secure-fields.swift" -o "$out/SecureReadbackFixture.app/SecureReadbackFixture"
cat > "$out/SecureReadbackFixture.app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>SecureReadbackFixture</string>
<key>CFBundleIdentifier</key><string>dev.contingency.secure-readback-fixture</string>
<key>CFBundleName</key><string>SecureReadbackFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>UILaunchScreen</key><dict/>
<key>UIApplicationSceneManifest</key><dict>
<key>UIApplicationSupportsMultipleScenes</key><false/>
<key>UISceneConfigurations</key><dict><key>UIWindowSceneSessionRoleApplication</key><array><dict>
<key>UISceneConfigurationName</key><string>Default</string>
<key>UISceneDelegateClassName</key><string>SecureReadbackFixture.FixtureSceneDelegate</string>
</dict></array></dict>
</dict>
</dict></plist>
PLIST
