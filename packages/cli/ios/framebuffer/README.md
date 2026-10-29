# iOS framebuffer helper

This Contingency-owned helper samples the selected simulator's active integrated display. It exposes no input API. The parent chooses an exact device UDID and display-port UUID from that device's `simctl io enumerate` inventory. No display or simulator fallback is permitted.

Published CLI tarballs include a prebuilt universal arm64 + x86_64 helper. Release and PR artifact CI compile it on a GitHub-hosted macOS runner, verify both architectures and its ad hoc signature, and transfer it to the Ubuntu packaging job after the CLI build. Users do not compile this helper.

For source development on macOS, build the same artifact with:

```sh
CONTINGENCY_BUILD_IOS_FRAMEBUFFER=1 nub exec turbo run build --filter=@contingencyhq/cli --force
```

The build compiles each architecture with `xcrun clang -arch`, combines them with `lipo`, ad hoc signs and verifies the executable, and writes a versioned manifest with source and binary SHA-256 digests under `packages/cli/dist/ios/framebuffer`. Runtime checks the manifest version, supported host, actual Mach-O executable slices, and binary digest before execution. The digest pins the exact packaged build despite Xcode-dependent compiler output. It detects corruption or replacement of the binary alone; an adjacent manifest does not authenticate the publisher. npm provenance supplies package origin evidence. Ad hoc signing is not Developer ID signing or notarization. `Clean-host iOS helper` proves native arm64 and x86_64 execution in CI. Ordinary source builds omit the backend unless explicitly enabled.

The executable accepts developer directory, selected simulator UDID, display UUID and orientation. Stdin controls `start`, `stop`, `orientation <value>` and `display <UUID>`. EOF releases the helper. Only the parent may request a display rebind, after positively identifying the replacement integrated display on the same device. Stdout is bounded-size newline-delimited JPEG packets with display identity, output sequence, compositor callback count and monotonic timestamps. Compositor callback count does not establish complete upstream capture.

Private CoreSimulator selectors are checked at runtime and may change with Xcode. iOS is listed within the support matrix; Developer ID signing and notarization remain evidence gaps. Clean-machine installation is proven by `Clean-host iOS helper`. See `docs/reports/ios-workspace-runs.md` for the internal gate, rotation behavior, live proof and remaining evidence gaps.

## Clean-host CI proof

CI runs `Clean-host iOS helper` on `macos-latest` Apple Silicon and `macos-26-intel` Intel runners. Each consumes the exact tarball uploaded by Ubuntu's `Verify release artifact` job. Release publishing waits for both architectures and publishes that same tarball.

`packages/release/src/verify-ios-helper.ts` installs the tarball offline into a fresh npm prefix with an isolated HOME and cache. It checks `lipo`, strict signing across both architectures, absence of quarantine, and the runtime manifest. It creates one supported iPhone on the newest available iOS runtime, boots it with `simctl boot` and `bootstatus -b`, and selects the integrated `Display class: 0` port with an `IOSurface port`. For a multi-panel iPhone, it matches the explicitly named `primary` integrated screen to its port dimensions and refuses unresolved ambiguity. It validates at least three packets for positive dimensions, increasing sequence, source counter, and selected display identity, sends `stop`, and requires exit 0. Cleanup deletes only the exact simulator UDID it created, including on failure.

Logs include the runtime, simulator UDID, `uname -m`, `sysctl.proc_translated`, and the running helper's code type from macOS `sample`. The job explicitly selects its expected executable slice and requires an ARM64 or x86_64 code type matching the native host. It accepts both current and older `sample` spellings and rejects translated code types. The host must also report no translation, so a translated Intel run cannot pass.

To repeat the proof on a Mac with Xcode and an installed iOS runtime:

```sh
nub packages/release/src/main.ts verify-ios-helper /absolute/path/cli.tgz --architecture arm64
# On an Intel Mac, use --architecture x86_64.
```

No existing path-filter convention exists, so CI runs this proof on every PR and main push. The release workflow always runs it before publishing.
