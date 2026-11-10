#!/bin/sh
set -eu
out=${1:?Usage: build.sh OUTPUT_DIRECTORY}
fixture=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$out/IosWidgets.app"
xcrun --sdk iphonesimulator clang -fobjc-arc -target arm64-apple-ios26.0-simulator \
  -isysroot "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -framework UIKit -framework WebKit -framework CoreGraphics "$fixture/fixture.m" -o "$out/IosWidgets.app/IosWidgets"
cp "$fixture/Info.plist" "$out/IosWidgets.app/Info.plist"
