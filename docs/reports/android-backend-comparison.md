# Android backend comparison

For [issue 467](https://github.com/akshat-OwO/contingency/issues/467), use the stock typed client for experimental Android support that retains Teaching, Flow Skill learning, Dry Run, and user verification using non-secret inputs. Defer private Variables and web feature parity. Its private-text and coordinate dispatch paths do not meet the complete contract in [ADR 0058](../adr/0058-android-is-the-next-platform-runtime.md); unsupported capabilities remain explicit. The [experimental scope](android-experimental-scope.md) defines the limits and shipping proof. The [upstream extension investigation](android-upstream-extension-investigation.md) and [full-contract handoff](android-production-handoff.md) remain later options. Evaluate expo-device-hub separately as the implementation for the required mirrored Teaching path. [ADR 0060](../adr/0060-use-stock-agent-device-for-an-experimental-android-runtime.md) records the revised proposal.

This evaluation ships no runtime, helper fork, Workspace integration, or checkout fixture. It does not establish full Android support or close issue 457.

## Evaluated versions and sources

The evaluation ran on 2026-10-13 at Contingency revision `5d3b5bf4374ce960d89ff4b41cbd7d4051eddeca`. T3's live device inventory reported agent-device 0.21.25 and expo-device-hub 0.15.3. Installed package versions and APK manifests were inspected independently.

| Component | Evaluated release and source |
| --- | --- |
| agent-device installed CLI and exported Node client | 0.21.25; release source `9dabb5b11bf030a8fc0b475dc99ba4718abeca32` |
| Android snapshot APK | 0.21.25; SHA-256 `79175080eb71f444224c844a599e75e839d6456790eb96d175fc887f85237a12`; helper API 2, status protocol `android-snapshot-helper-v1`, minimum API 23, target API 36 |
| expo-device-hub | 0.15.3; release source `42918bc8e66021da5a983aaa09b43365e58c3dce`; bundled serve-emu 0.0.5 |
| Contingency prototype | Repository revision above; protocol 1; minimum API 30; UI Automator 2.3.0, Gradle 9.3.1, Android Gradle Plugin 8.12.0, compile SDK 36 |
| Prototype APK built for this evaluation | SHA-256 `cb6a609f66d6e3f1f0ef125fd212816f172fcaae4dd603eb7fcbc15a5382848e` |
| Selected device | Pixel_9, `emulator-5554`, API 36, arm64; fingerprint in the receipt |
| Host tools | ADB 37.0.1-15733141; emulator 36.4.10.0 |

The earlier feasibility report inspected agent-device upstream `f2e74d237ae6f60dd8970dad1b7c70b17235e1d0`. That checkout identifies itself as 0.21.27-dev. This evaluation fetched and inspected the 0.21.25 release separately. Likewise, hub main `54a8331db0a38b3c2771133b372f9ecb08cdbcd0` is not the release pin. The cited implementation findings below use the release sources.

## Evidence categories

The committed [evidence receipt](android-backend-evidence.json) contains sanitized command outcomes, observation identities, capture metadata, cleanup results, and hashes of purged PNGs. Agent CLI evidence is local under `.cursor/skills/verify-contingency/artifacts/android-467/`. The unchanged prototype runner restricts artifacts to `android-463`, so this comparison uses its separate `android-463/evaluation-467/` directory. No earlier issue 463 receipt is counted as a new live result.

The user selected Pixel_9 and authorized evaluation helper installation and cleanup. Initial `adb devices -l` was empty. T3 `device_open` returned `Device Pixel_9 failed to boot: The simulator or emulator could not start. Check its configuration on the environment server.` The installed emulator launcher started that same AVD. Once booted, T3's inventory identified it by serial `emulator-5554`, and `device_open` made it visible in the Device panel.

The first emulator process exited during the evaluation. An attempted agent-device tap returned `device_not_found` with `dispatched: no`; no success or automatic recovery is inferred. A fresh headless launch of the same selected AVD was revalidated with `emu avd name`. The prior agent session was closed, its previous IME restored, and the comparison restarted with fresh observations. The reason for the first process exit was not established.

Live emulator results are:

| Path | Observed result and limit |
| --- | --- |
| agent-device `open com.android.settings --foreground` | Explicit serial selection; automatic missing snapshot-helper installation; persistent multi-window capture, API 2, two windows, no missing roots, no helper truncation. Public Search Settings label retained. |
| Generation-pinned semantic click | `@e3~s249161` opened Settings search. The response disclosed exact ref resolution and a coordinate tap. Search belongs to `com.google.android.settings.intelligence`, demonstrating that the session app label alone is not Contingency app-boundary enforcement. |
| Reuse of the old pinned target | Returned `ref_generation_mismatch`, current generation 249167, `dispatched: no`. No replacement target was clicked. |
| Fresh search snapshot | Three interactive windows, no missing roots, no helper truncation. Captured both the search field and Gboard, with `keyboard.kind: visible`. This is IME evidence, not arbitrary-overlay or OS-permission proof. |
| Stock coordinate press at 68, 203 | Returned success; a separate snapshot showed Settings again. It accepted coordinates without a Contingency observation ID. This proves operation, not stale-coordinate safety. |
| Exported `createAgentDeviceClient` | Opened explicit serial with `testIme: false`, `noRecord: true`; captured through the persistent helper. An already-aborted snapshot returned `request_canceled`, `dispatched: no`; independent readback succeeded with a new generation. In-flight action cancellation remains unproved. |
| Prototype coordinate at 400, 945 | Opened the Device name editor; reuse returned `observation_stale`. Immediate after capture returned `capture_changed`, so that capture is incomplete. A new private-probe observation independently found the editor. |
| Prototype semantic private fill | `android:id/edit` accepted an internally generated value through `ACTION_SET_TEXT`. Journal retained `PROBE_INPUT`, helper readback matched, replay was refused, and the recent diagnostic search reported `diagnosticsContainedPrivateValue: false`. No secret was passed to the stock text backend. |
| Prototype semantic Cancel | Returned `ownership_ambiguous` after dispatch. Replay returned `observation_stale`. Fresh readback showed the editor gone. This is an ambiguous action outcome followed by observation, not a successful error-free action. |
| Prototype injected capture failure | Real helper returned `capture_failed`; state became paused with no observation. Fresh capture produced a different identity. Fault injection is not secure-window coverage. |
| Prototype helper force-stop | Returned `transport_failed`; paused and cleared the observation. Subsequent observation also failed. Recovery used a new helper session. |
| Prototype ownership boundary | Known Chrome launch returned `launch_unauthorized`. An external test transition to Chrome then returned `ownership_denied`, paused, and cleared observation. Further observation remained refused; explicit return to Settings and a new session restored observation. |

The existing prototype protocol suite passed all 14 tests. Those tests cover handshake capability refusal, version and request correlation, stale observations, concurrent dispatch, private action records, failure invalidation, and close. Missing-capability and correlation failure are protocol-test evidence, not live incompatible-APK evidence. No production code or test changed.

## Driver contract comparison

| Requirement | Stock agent-device 0.21.25 | Contingency prototype | Production implication |
| --- | --- | --- | --- |
| Explicit device selection and serial binding | CLI and typed options accept serial; live response reports explicit selection. Session and device-claim machinery exist. | Required serial, every ADB command bound with `-s`, per-serial lock; no alternate device fallback. | Bind host, serial, device identity, and Run together. Do not use a default singleton or name lookup as authority. Multi-device proof remains blocked. |
| Installation authority | Helper-backed snapshot installs missing or outdated helper automatically. Normal open can activate the test IME; typed open can disable it. | Installation is a separate authorized operation; refuses missing or preexisting running helper. | Authorize installation or replacement before starting; verify signer and hash. Do not equate observing the device with installation permission. |
| Protocol and correlation | Persistent snapshot, viewport, gesture, and quit commands echo request IDs. Helper loopback server has no per-session authentication credential. Daemon transport has separate authentication. | Version, ID, helper session, and token on each request; fixed error codes. | Own the protocol; reject mismatched session, ID, version, or capabilities. Loopback alone is insufficient helper-session authentication. |
| Observation invalidation | Pinned ref frames expire at the side-effect seam. Live old-generation refusal passed. | Host consumes the observation before dispatch; helper compares foreground and fingerprints, including a screenshot for coordinates. | Keep both host and device checks. Stock ref generations do not supply an observation-bound coordinate contract. |
| Cancellation and replay | Node request overrides accept `AbortSignal`; pre-aborted request refused live. Android fill can clear, commit, rebind or refocus, and retry internally. | Socket closes on interruption; action outcome may be unknown. Old observations remain consumed. | Propagate Effect interruption, pause, observe, and require a new action attempt. Do not retry an ambiguous dispatch or import the stock fill retry path. |
| Ownership evidence | Foreground and blocking-dialog readers inspect focused window and activity dumps; permission packages are recognized. Captures include multiple packages. | Active accessibility root plus UI Automator package must match the single target. Ambiguous or foreign package refuses. | Add window-aware, trigger-linked necessary-dialog authority. Neither session app metadata nor a package allowlist is sufficient. |
| Capture completeness | Interactive windows, active-root fallback, missing-root types, depth and node bounds, truncation, keyboard and viewport metadata. | Active root only; bounded traversal; no complete multi-window inventory. | Reuse acquisition metadata. A fallback or missing required root is an evidence gap, not a healthy complete capture. |
| Private text | Test IME encodes text as base64 in ADB broadcast arguments; shell fallback uses `input text`. Diagnostics emit text length; sensitive-fill substitution exists, but does not remove encoded argv transport. | Authenticated socket, semantic text action, internal readback; exported nodes omit every UI name. | Reject stock transport for Variables. Preserve useful public names through a redacted semantic projection, rather than removing all text. |
| Lifecycle cleanup | Session close restored the prior IME in live proof; snapshot-helper process and forwards were absent afterward, but the installed snapshot APK remained. | Scoped connection, forward, helper, and lock finalizers; installation removal explicit. | Own only acquired resources; record crash recovery and signing identity; never adopt or remove another session's helper. |

Release source anchors are [snapshot helper protocol and packaging](https://github.com/callstack/agent-device/blob/9dabb5b11bf030a8fc0b475dc99ba4718abeca32/android/snapshot-helper/README.md), [helper request loop](https://github.com/callstack/agent-device/blob/9dabb5b11bf030a8fc0b475dc99ba4718abeca32/android/snapshot-helper/src/main/java/com/callstack/agentdevice/snapshothelper/SnapshotInstrumentation.java), [capture acquisition](https://github.com/callstack/agent-device/blob/9dabb5b11bf030a8fc0b475dc99ba4718abeca32/android/snapshot-helper/src/main/java/com/callstack/agentdevice/snapshothelper/AccessibilityTreeCapture.java), [ref-frame lifetime](https://github.com/callstack/agent-device/blob/9dabb5b11bf030a8fc0b475dc99ba4718abeca32/src/daemon/ref-frame.ts), [text dispatch and retry](https://github.com/callstack/agent-device/blob/9dabb5b11bf030a8fc0b475dc99ba4718abeca32/packages/platform-android/src/text-input.ts), [IME argument transport](https://github.com/callstack/agent-device/blob/9dabb5b11bf030a8fc0b475dc99ba4718abeca32/packages/platform-android/src/ime-helper.ts), and [diagnostic redaction](https://github.com/callstack/agent-device/blob/9dabb5b11bf030a8fc0b475dc99ba4718abeca32/packages/kernel/src/redaction.ts). These are source findings, not additional live tests.

## Android API choices and coverage limits

Current official documentation was inspected on the evaluation date. [UiAutomation.getWindows](<https://developer.android.com/reference/android/app/UiAutomation#getWindows()>) requires `FLAG_RETRIEVE_INTERACTIVE_WINDOWS` and returns interactable windows, not every rendered window. A modal dialog can hide the windows behind it from this inventory. On API 30 and later, `getWindowsOnAllDisplays` supports display-aware acquisition; production must bind actions and capture to the selected display rather than infer all-display coverage from the default display.

[AccessibilityWindowInfo](https://developer.android.com/reference/android/view/accessibility/AccessibilityWindowInfo) identifies application, IME, and system window types. Use those facts with package, focus, layer, bounds, and trigger evidence to classify ownership. A keyboard is not itself an authorization grant. The live Gboard result does not prove unrelated overlays or permission-dialog attribution.

Use the documented [ACTION_SET_TEXT](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo.AccessibilityAction#ACTION_SET_TEXT) for supported fields. The fork must report refusal when the action or safe readback is unavailable. Upstream gesture dispatch attempts a hidden three-argument `injectInputEvent` through reflection and falls back to the public overload. Use the documented [UiAutomation input contract](<https://developer.android.com/reference/android/app/UiAutomation#injectInputEvent(android.view.InputEvent,%20boolean)>) as the production baseline; do not advertise a required capability based on hidden APIs.

[FLAG_SECURE](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_SECURE) prevents secure content from appearing in screenshots or non-secure displays. Do not bypass it. A PNG or working stream does not prove that the required outcome is visible. No prepared secure-window target was available, so this path remains blocked and any required obscured outcome stays inconclusive.

[ADB's serial-selection contract](https://developer.android.com/tools/adb#directingcommands) supports explicit `-s`. Physical routing is structurally possible in both backends but was not exercised. The inventory contained no physical serial and only one attached emulator. The stopped second AVD was not selected or booted. Exact prerequisites for physical, multiple-device, OS-dialog, overlay, secure-window, in-flight cancellation, and Workspace proof are in the receipt and handoff. API 23 or API 30 minimum declarations do not extend this API 36 coverage.

## Private evidence and semantic usefulness

The stock private-text route is rejected by source inspection. Base64 is reversible and places the supplied value in command arguments before any diagnostic substitution. The live stock failure also showed that structured errors can retain ADB argv. Plain-value substitution cannot be assumed to remove encoded values. No real private value was sent through that route to demonstrate an already-established leak mechanism.

The prototype's positive result is narrower. It searched recent diagnostics and its journal for one generated value. It does not prove target apps or keyboards never log input, general redaction, password readback, or a learning contract. Production needs public semantic labels and Variable-aware substitution of text, descriptions, hints, values, reflected strings, and error data. Raw media and raw trees remain sensitive local evidence. Keep those separate from the agent-readable projection and purge them after verification.

## Expo-device-hub mirroring evaluation

The pinned hub separates screen streaming from automation. Its Android stream source supports emulator gRPC capture and scrcpy; physical serials support scrcpy only. `device_open` showed the selected emulator in T3's Device panel. This is live transport availability through T3, not a measured Contingency capture interval or input-authority proof.

Source inspection found a default CLI bind of `127.0.0.1`, typed stream and control contracts, and REST input routes for tap, swipe, text, and keys. Those routes dispatch directly through hub dependencies, with no Contingency authority decision. The Android `SessionRecorder` starts with `recording = true` and supports replay, so its default event lifecycle must not define Teaching. The stream source contains keyframe buffering and bounded startup handling, but frame delivery is not equivalent to before-and-after semantic evidence.

The source anchors are [CLI host defaults](https://github.com/expo/expo-device-hub/blob/42918bc8e66021da5a983aaa09b43365e58c3dce/packages/expo-device-hub/src/server/cli/options.ts), [serial-specific stream capabilities](https://github.com/expo/expo-device-hub/blob/42918bc8e66021da5a983aaa09b43365e58c3dce/packages/serve-emu/packages/serve-emu/src/device-capabilities.ts), [stream lifecycle](https://github.com/expo/expo-device-hub/blob/42918bc8e66021da5a983aaa09b43365e58c3dce/packages/serve-emu/packages/serve-emu/src/stream-session.ts), [unrestricted input routes](https://github.com/expo/expo-device-hub/blob/42918bc8e66021da5a983aaa09b43365e58c3dce/packages/serve-emu/packages/serve-emu/src/api/routes/input.ts), and [recorder lifecycle](https://github.com/expo/expo-device-hub/blob/42918bc8e66021da5a983aaa09b43365e58c3dce/packages/serve-emu/packages/serve-emu/src/session-recorder.ts).

The recommendation is conditional reuse behind a supervised, authenticated, allowlisted Contingency loopback proxy. Host and serial selection, Origin and WebSocket authentication, Takeover, input routing, queue bounds, and Start-to-Stop capture acknowledgements require a production adapter and independent proof. Keep the semantic driver usable without the hub. Do not ship the hub dashboard or its raw input routes as Workspace authority. The packaging and capture obligations are specified in the handoff.

## Reproduction commands

These commands reproduce the source and prototype checks. Obtain a fresh explicit device selection and installation grant for each evaluation. Never assume `emulator-5554` identifies Pixel_9 on another host. Read [the prototype procedure](../../packages/cli/prototypes/android/README.md) for its prerequisites and cleanup ownership.

```sh
git clone --branch v0.21.25 --depth 1 https://github.com/callstack/agent-device.git /tmp/agent-device-467-release
git -C /tmp/agent-device-467-release rev-parse HEAD
git clone --branch expo-device-hub@0.15.3 --depth 1 https://github.com/expo/expo-device-hub.git /tmp/device-hub-467-release
git -C /tmp/device-hub-467-release rev-parse HEAD
adb devices -l
adb -s "$PROBE_SERIAL" get-state
adb -s "$PROBE_SERIAL" emu avd name
nub packages/cli/prototypes/android/build-helper.ts
adb -s "$PROBE_SERIAL" install packages/cli/prototypes/android/helper/build/outputs/apk/debug/contingency-android-probe-debug.apk
adb -s "$PROBE_SERIAL" shell am start -W -a android.settings.DEVICE_INFO_SETTINGS
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/evaluation-467/observe
```

Inspect that observation and screenshot before choosing the Device name row. On this evaluated layout the coordinate was 400, 945. The following scenarios use separate helper sessions and artifact directories:

```sh
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/evaluation-467/coordinate coordinate 400 945
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/evaluation-467/private private android:id/edit
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/evaluation-467/cancel click android:id/button2
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/evaluation-467/capture-failure capture-failure
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/evaluation-467/launch-denied launch-denied
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/evaluation-467/helper-failure helper-failure
nub exec --filter @contingencyhq/cli vitest run prototypes/android/driver.test.ts
```

Run `cross-app` only when the external Chrome test transition is authorized. Return explicitly to Settings afterward, then capture through a new session. It does not interact with Chrome onboarding or change target-app data.

For the stock comparison, call T3 `device_list` and `device_open` for the selected serial. Use the exact launcher, host `--config`, and `--session` returned by `device_open` on every CLI command. The receipt preserves each command with the private config path replaced. Execute `open com.android.settings --foreground --json`, select the observed Search Settings ref with its generation, and click it with `--settle --json`. Reuse that old pinned ref once to assert refusal, then run `snapshot -i --json`. Inspect the fresh tree, press the observed Back coordinate, and use a separate snapshot for readback. Close the session. Never reuse this report's ref or generation on a new session.

The exported Node probe uses the same private host profile and session. Import `createAgentDeviceClient` from the installed, version-checked 0.21.25 package. Pass the profile's `daemonBaseUrl` and `daemonAuthToken` to the client without retaining either. Run these calls through `Effect.tryPromise` with scoped cleanup:

```js
const client = createAgentDeviceClient({ ...privateHostProfile, session });
await client.apps.open({
  app: "com.android.settings",
  platform: "android",
  serial: selectedSerial,
  foreground: true,
  testIme: false,
  noRecord: true,
});
try {
  const before = await client.capture.snapshot({ interactiveOnly: true });
  const controller = new AbortController();
  controller.abort();
  // Assert request_canceled and dispatched: no. Do not treat rejection as success.
  try {
    await client.capture.snapshot({ signal: controller.signal });
    throw new Error("Expected cancellation refusal");
  } catch (error) {
    if (
      error.details?.reason !== "request_canceled" ||
      error.details?.dispatched !== "no"
    ) {
      throw error;
    }
  }
  const after = await client.capture.snapshot({ interactiveOnly: true });
  // Retain only capture metadata and generation identities from before and after.
} finally {
  await client.sessions.close();
}
```

The retained local Effect probe is `android-467/sdk-probe.mjs`; its sanitized result is embedded in the receipt. This snippet describes the same exported calls without relying on that machine-specific script. Cancellation proof is deliberately pre-dispatch only.

## Validation and cleanup

Helper build, all 14 prototype protocol tests, `nub exec turbo run quality`, and `nub exec turbo run check-types` passed. Workspace and checkout recipes were not run or claimed because this change has no production UI or runtime integration.

Each prototype invocation finalized its owned process, connection, forward, and lock. Agent session close restored Gboard; helper processes and forwards were absent. The evaluation uninstalled only its previously absent prototype and stock snapshot helper. The stock IME helper was absent at cleanup. Independent readback confirmed the unchanged device name `sdk_gphone64_arm64` and restored default IME. T3 `device_close` shut down the owned emulator, and final `adb devices -l` was empty.

PNG hashes were recorded before every raw PNG in this evaluation was purged. Android diagnostics were searched without retaining their content. No raw tree, PNG, diagnostic log, private value, authentication credential, or user catalog was copied into the committed receipt. Source clones and sanitized local journals are retained for inspection. Cleanup did not reset Settings, Chrome, other installed apps, unrelated forwards, or the user's catalog.
