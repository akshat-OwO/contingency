# iOS framebuffer helper

This Contingency-owned helper samples the selected simulator's active integrated display. It exposes no input API. The parent chooses an exact device UDID and display-port UUID from that device's `simctl io enumerate` inventory. No display or simulator fallback is permitted.

Published CLI tarballs include a prebuilt universal arm64 + x86_64 helper. Release and PR artifact CI compile it on a GitHub-hosted macOS runner, verify both architectures and its ad hoc signature, and transfer it to the Ubuntu packaging job after the CLI build. Users do not compile this helper.

For source development on macOS, build the same artifact with:

```sh
CONTINGENCY_BUILD_IOS_FRAMEBUFFER=1 nub exec turbo run build --filter=@contingencyhq/cli --force
```

The build compiles each architecture with `xcrun clang -arch`, combines them with `lipo`, ad hoc signs and verifies the executable, and writes a versioned manifest with source and binary SHA-256 digests under `packages/cli/dist/ios/framebuffer`. Runtime checks the manifest version, supported host, actual Mach-O executable slices, and binary digest before execution. The digest pins the exact packaged build despite Xcode-dependent compiler output. It detects corruption or replacement of the binary alone; an adjacent manifest does not authenticate the publisher. npm provenance supplies package origin evidence. Ad hoc signing is not Developer ID signing or notarization. Only arm64 has live execution evidence. Ordinary source builds omit the backend unless explicitly enabled.

The executable accepts developer directory, selected simulator UDID, display UUID and orientation. Stdin controls `start`, `stop`, `orientation <value>` and `display <UUID>`. EOF releases the helper. Only the parent may request a display rebind, after positively identifying the replacement integrated display on the same device. Stdout is bounded-size newline-delimited JPEG packets with display identity, output sequence, compositor callback count and monotonic timestamps. Compositor callback count does not establish complete upstream capture.

Private CoreSimulator selectors are checked at runtime and may change with Xcode. iOS is listed within the support matrix; Developer ID signing, notarization and clean-machine qualification remain evidence gaps. See `docs/reports/ios-workspace-runs.md` for the internal gate, rotation behavior, live proof and remaining evidence gaps.
