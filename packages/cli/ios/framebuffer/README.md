# iOS framebuffer helper

This Contingency-owned helper samples the selected simulator's active integrated display. It exposes no input API. The parent chooses an exact device UDID and display-port UUID from that device's `simctl io enumerate` inventory. No display or simulator fallback is permitted.

On macOS, build the optional artifact with:

```sh
CONTINGENCY_BUILD_IOS_FRAMEBUFFER=1 nub exec turbo run build --filter=@contingencyhq/cli --force
```

The build compiles this source for the current arm64 or x64 host, ad hoc signs and verifies the executable, and writes a versioned manifest with source and binary SHA-256 digests under `packages/cli/dist/ios/framebuffer`. Runtime checks the architecture, version and binary digest before execution. Only arm64 has live execution evidence. Ordinary builds omit the optional backend.

The executable accepts developer directory, selected simulator UDID, display UUID and orientation. Stdin controls `start`, `stop`, `orientation <value>` and `display <UUID>`. EOF releases the helper. Only the parent may request a display rebind, after positively identifying the replacement integrated display on the same device. Stdout is bounded-size newline-delimited JPEG packets with display identity, output sequence, compositor callback count and monotonic timestamps. Compositor callback count does not establish complete upstream capture.

Private CoreSimulator selectors are checked at runtime and may change with Xcode. iOS stays unlisted; Developer ID signing, notarization and clean-host qualification belong to #550. See `docs/reports/ios-workspace-runs.md` for the internal gate, rotation behavior, live proof and remaining evidence gaps.
