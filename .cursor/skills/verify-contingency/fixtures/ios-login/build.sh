#!/bin/sh
set -eu
out=${1:?Usage: build.sh OUTPUT_DIRECTORY}
fixture=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$out/IosLogin.app"
xcrun --sdk iphonesimulator clang -fobjc-arc -target arm64-apple-ios26.0-simulator \
  -isysroot "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -framework UIKit -framework Photos -framework UserNotifications "$fixture/fixture.m" -o "$out/IosLogin.app/IosLogin"
cp "$fixture/Info.plist" "$out/IosLogin.app/Info.plist"
