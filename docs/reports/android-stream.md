# Android Workspace live stream

Issue #486 was implemented and checked on 2026-10-15 using the working tree's production CLI and embedded Workspace. Live Workspace proof passed on both Pixel_9 API 36 and the explicitly authorized Nothing Phone 3a, Android 16 API 36.

## Implementation

Contingency uses the stock scrcpy transport packaged in expo-device-hub 0.15.3 inside one session-owned child process. The hub dashboard, recorder, input API, installation API, and replay API are never loaded. The proxy exposes only an authenticated GET for the session's frames. The host and serial come from the prepared session; requests cannot supply another device. Credentials stay in request headers and are absent from MCP snapshots and URLs.

Workspace decodes the live H.264 display with WebCodecs. Each viewer starts on a keyframe, and bounded queues disconnect slow viewers. The display has no input listeners or overlays. Teaching evidence continues to use observation keyframes. Stream loss does not change session authority or pause semantic actions. Secure windows show a notice above the display, and unknown visibility suppresses frames. The secure-window diagnostic can lag by one second; Android secure-surface protection still applies to the underlying scrcpy capture.

The bundled scrcpy 4.0 server is hash-checked before use. Packaging includes only the required hub transport files and their licenses, with no runtime download or dependency on T3 Code's installation. See the [transport inventory](../../packages/cli/android/stream/README.md).

## Emulator proof

The [Android live stream recipe](../../.cursor/skills/verify-contingency/features/workspace.md#android-live-stream) ran on an explicitly authorized Pixel_9 API 36 emulator, serial `emulator-5586`. It installed a disposable public fixture, operated it through Workspace's semantic controls, and uninstalled it afterward.

| Check | Result |
| --- | --- |
| Decoded live frames in Workspace | Passed |
| Pixel digest changes after a semantic screen change | Passed |
| Secure-window notice and restored display after clearing FLAG_SECURE | Passed |
| Missing or wrong stream credential | Refused with 401 |
| Another session's credential binding | Refused with 401 |
| Serial supplied through query parameters | Refused with 404 |
| Input, installation, recording, replay, and WebSocket upgrades | Refused with 404 |
| SIGKILL of the owned worker | Visible stream-loss state |
| Semantic action after worker loss | Passed, session running with no capture gaps |
| Reconnect through Workspace | Passed |
| Close session | Worker exits and ADB forwards return to baseline |

The emulator receipt, command journal, ARIA snapshots, and screenshots are under `.cursor/skills/verify-contingency/artifacts/android-stream/`. They are local, ignored verification evidence. The run passed every emulator coverage entry. Its physical-device authorization blocker was subsequently resolved by the separate physical proof below.

Focused service and route tests cover credential isolation and revocation, keyframe joins, stream loss, cleanup retry, secure-window flag parsing, the proxy allowlist, Origin and Host checks, and existing Workspace and RPC paths. The production build, TypeScript checks, and repository quality checks passed.

## Physical-device proof

The user explicitly authorized physical verification. The same production Workspace proof ran on the Nothing Phone 3a, model `A059`, Android 16 API 36. It selected `Physical device`, declared notification denial, and granted clearing only the newly installed disposable fixture through Workspace's `Clear Target App data` decision. The preexisting snapshot helper was preserved. No phone reset or settings changes outside the Target App were performed.

The physical receipt has empty `blockers` and passes `live`, `changedFrame`, `secureWindow`, `lossLeavesSemanticInput`, `reconnect`, and `cleanup`. Its proxy probes return the same 401 and 404 refusals listed in the emulator table. SIGKILL of the session-owned worker shows stream loss while a semantic action still succeeds, the session remains running, and capture gaps remain empty. Reconnecting restores decoded frames, and closing the session stops the worker and returns ADB forwards to baseline.

Cleanup uninstalled only the fixture installed by this proof. The `deviceStateRestored` and `forwardsRestored` checks pass: installed-package hashes, default and enabled input methods, and ADB forwards match their pre-install baselines. The phone was left powered on. The owned Device panel stream and local verification processes were closed.

The Device panel retained a cached scrcpy transport after its tab closed. Final cleanup stopped only the transport process created by this verification and removed its exact forward and working jar. The shared T3 hub was preserved. A final read found no device forwards, scrcpy process, or snapshot-helper process, and the local verification ports were closed.

The physical receipt, journal, consent screenshot, ARIA snapshots, and display screenshots are under `.cursor/skills/verify-contingency/artifacts/android-stream-physical/`. The combined emulator and physical-device acceptance criteria for #486 are now verified.

## Scope limits

This change does not implement Teaching video from the stream or pointer and keyboard dispatch through the display. Those belong to later issues. It does not qualify Android as generally supported.
