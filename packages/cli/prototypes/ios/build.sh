#!/bin/sh
# Build outside the repository. Nothing here enters the shipped CLI.
set -eu
out=${1:?Usage: build.sh OUTPUT_DIRECTORY}
mkdir -p "$out/StreamFixture.app"
xcrun clang -O2 -Wall -Wextra -Wno-unused-parameter -fobjc-arc \
  -framework Foundation -framework CoreImage -framework IOSurface \
  -framework ImageIO -framework CoreGraphics \
  packages/cli/prototypes/ios/framebuffer.m -o "$out/framebuffer"
xcrun --sdk iphonesimulator clang -fobjc-arc -target arm64-apple-ios26.0-simulator \
  -isysroot "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -framework UIKit -framework QuartzCore \
  packages/cli/prototypes/ios/fixture.m -o "$out/StreamFixture.app/StreamFixture"
cp packages/cli/prototypes/ios/fixture.plist "$out/StreamFixture.app/Info.plist"
