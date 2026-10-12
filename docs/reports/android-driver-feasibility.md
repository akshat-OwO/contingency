# Android driver feasibility for issue 463

The isolated Android driver and instrumentation helper work on the user-selected Pixel_9 emulator running Android 16, API 36. The proof covers semantic observation, screenshots, semantic private input, coordinate fallback, stale-target refusal, foreground refusal, helper failure, an injected capture failure, disconnect, and fresh-session recovery. Physical-device proof, multiple attached devices, secure-window behavior, and necessary system-dialog classification remain blocked or unverified. This result is not Android product support and does not complete issue 457.

The prototype is in [packages/cli/prototypes/android](../../packages/cli/prototypes/android/README.md). It does not change production runtime services or Workspace. The report follows [ADR 0058](../adr/0058-android-is-the-next-platform-runtime.md). Evidence was captured on 2026-10-12 under `.cursor/skills/verify-contingency/artifacts/android-463/`, with separate physical-device blockers. The [evidence receipt](android-driver-evidence.json) preserves command outcomes, observation identities, and media hashes after sensitive-media cleanup.

## Emulator evidence

The user explicitly selected Pixel_9 and authorized helper installation. `adb devices -l` initially listed no attached device. T3's `device_open` returned `Device Pixel_9 failed to boot: The simulator or emulator could not start. Check its configuration on the environment server.` Starting that same authorized AVD with the installed emulator executable succeeded. `adb -s emulator-5554 emu avd name` returned `Pixel_9`; the serial was passed to every device command.

The helper was built with the committed Gradle 9.3.1 wrapper, Android Gradle Plugin 8.12.0, SDK 36, and UI Automator 2.3.0. It was absent before installation. Installation, instrumentation startup, version-1 handshake, capability discovery, owned shutdown, and forward removal succeeded. A later run after uninstalling the helper failed with `helper_missing`. Missing capabilities, incompatible versions, and mismatched request IDs were proved by protocol-client tests, not by installing a second incompatible APK.

The unmodified target was `com.android.settings`. The Device name editor provided a reversible text field. The proof never saved a changed name. Readback of `settings get global device_name` remained `sdk_gphone64_arm64`.

The final evidence paths and outcomes are:

| Artifact directory | Observed result |
| --- | --- |
| `coordinate-final` | A coordinate action at 400, 945 opened the Device name dialog. Before and after trees and screenshots were retained during verification. Reusing its observation returned `observation_stale`. |
| `private-final` | `android:id/edit` accepted a generated private value through a semantic action. Helper-side field readback matched. The action record contained only `PROBE_INPUT`. The recent Android diagnostic check reported `diagnosticsContainedPrivateValue: false`. Replay was refused. |
| `cancel-final` | Semantic activation of `android:id/button2` dismissed the editor, but transient post-action ownership returned `ownership_ambiguous` and paused execution. A fresh after observation showed the editor gone and the original name. Replay was refused. |
| `launch-denied-verified` | The known Chrome launch was refused with `launch_unauthorized` before transport dispatch. The observation was invalidated. |
| `cross-app-verified` | An external `am start -W` transition to Chrome caused `ownership_denied`. Further observation failed, and the client remained paused with no retained observation. |
| `capture-failure-verified` | The explicitly advertised prototype fault caused `capture_failed` in the real helper. The client paused and invalidated its observation. A subsequent fresh capture succeeded with a different observation ID. This is fault-injection evidence, not secure-window proof. |
| `helper-failure-final` | Force-stopping this helper caused `transport_failed`; execution paused and cleared the observation. No input was replayed. |
| `disconnect-final` | `adb -s emulator-5554 emu kill` stopped the selected emulator. The connection failed with `transport_failed`, execution paused, and later observation failed. No other device was selected. |
| `recovery-final` | The same Pixel_9 AVD was restarted, its serial and AVD identity revalidated, Settings explicitly reopened, and a new helper session produced fresh before and after observations. |
| `capture-off` | Switching the screen off caused `ownership_denied` before capture because the foreground left Settings. Waking the screen allowed a fresh observation. This does not establish `FLAG_SECURE` behavior. |
| `physical/journal.json` | Blocked. The device inventory contained no attached physical device and no authorized physical serial. |

Earlier experimental directories are superseded. In particular, early `UiObject2.setText()` probes are not privacy proof. The final helper differs by using the framework's semantic text action, and the final private probe checks diagnostics without exporting their content.

## Authorized launcher visibility regression

Review identified that Android 11 and later can filter `getLaunchIntentForPackage()` results when the caller lacks package visibility. The helper now declares intent queries for `MAIN` with `INFO` and `LAUNCHER`, matching the API's launch-resolution categories. These queries expose eligible launcher activities to lookup; they do not grant permission to launch any package. The exact target-package authorization check still runs first. This follows Android's [package-visibility declaration guidance](https://developer.android.com/training/package-visibility/declaring).

On the same API 36 Pixel_9 emulator, the already-installed, unmodified non-system app `com.enfinite.education.teacher` reproduced the failure. The `launch-authorized` probe first captured the app, returned Home, and asked the helper to launch its declared target. Before the manifest change, the response was `launch_unavailable`. After rebuilding and reinstalling only the helper, the response reported successful dispatch and the after observation belonged to the target app. An independent fresh session confirmed the foreground. The probe did not enter account data, accept prompts, or modify the target app.

The installed helper package itself has no launcher activity. Declaring that package as the test target still returned `launch_unavailable`, proving the missing-launcher failure remains explicit. The unauthorized Chrome launch was also refused before dispatch. These before-and-after journals are in `launch-before`, `launch-after`, `launch-after-observation`, `launch-unavailable`, and `launch-refusal-review`. The receipt's `launchVisibilityReview` section preserves their outcomes, observation identities, and the rebuilt helper hash. Raw screenshots were purged, the helper uninstalled, and the proof emulator stopped again.

## Helper protocol and driver boundaries

The helper is a separate, non-`testOnly` instrumentation APK, `dev.contingency.probe/.Probe`, targeting its own package. The target app remains unmodified. The host starts it through serial-bound ADB, allocates a host port with `forward tcp:0 tcp:8765`, and sends one newline-delimited JSON request per TCP connection. The device listener binds loopback. An ephemeral random token authenticates requests. The token is omitted from retained command records.

Every request carries `version`, `id`, `session`, and `op`. Responses echo the request ID and helper session, report version 1, and contain either a result or a fixed error code. `hello` negotiates the version and reports Android API, target package, and capabilities. Required startup capabilities are `semantic`, `screenshot`, `coordinate`, and `private-input`. The optional `fault-injection` capability gates the diagnostic capture-failure operation.

Operations are `hello`, `observe`, `action`, `launch`, `invalidate`, `close`, and the prototype-only `fault_capture`. Observations contain an identity, package, resource IDs, class roles, editability, clickability, bounds, display extent, and a PNG. Exported nodes omit text and content descriptions. Internal semantic fingerprints include those values so text changes still invalidate targets. These fingerprints remain inside the helper. Duplicate resource IDs fail with `target_ambiguous`; absent IDs cannot become semantic targets.

The Effect client uses Effect Atom state and a semaphore to serialize lifecycle, observation, and dispatch. A dispatch consumes its observation before resolving a Variable or sending input. The helper independently checks the session, observation, foreground owner, and semantic fingerprint. Coordinate fallback also compares the screenshot and validates its bounds. This conservative visual check can refuse blinking, animated, or time-changing screens. The prototype does not solve stable visual-region matching.

ADB commands always carry `-s SERIAL`. There is no device fallback, automatic reconnection, or replay. Transport cancellation closes the host socket. An action may already have reached the device when cancellation or a post-action ownership failure occurs, so its outcome is inconclusive until observed. The consumed observation stays invalid. Synchronous helper work is bounded by capture, request-size, traversal, and socket limits; there is no separate cancellation-message protocol or rollback.

Foreground checks compare the active accessibility root's package with UI Automator's current package and the declared target. Unknown and foreign ownership fail closed. This probe does not authorize system-dialog packages or additional apps. Production must classify a necessary dialog from its window and triggering action, keep additional-app permission scoped to the Run, and preserve Confirmation before irreversible input. A package check cannot prevent every transition initiated by the unmodified target, and the final check does not detect every physical touch or overlay race.

The prototype's per-device host lock prevents concurrent prototype processes from taking ownership of the helper. Startup refuses a preexisting helper process. Effect scope finalizers close the protocol, remove only the allocated forward, stop the helper, and release the lock. A crash can leave a lock requiring inspected manual recovery. APK installation and removal are explicit setup operations, not automatic driver actions.

## Private input and sensitive evidence

UI Automator 2.3.0's `UiObject2.setText()` emitted the generated test value in the `UiObject2` Android diagnostic tag during investigation. The helper therefore uses `AccessibilityNodeInfo.ACTION_SET_TEXT` and verifies the resulting text internally. The official [AccessibilityAction documentation](https://developer.android.com/reference/android/view/accessibility/AccessibilityNodeInfo.AccessibilityAction) defines this semantic action and its text argument. The host sends the value through the authenticated socket rather than ADB command arguments. Action records retain the Variable reference.

The final private probe searched recent device diagnostics for its generated value and retained only a boolean result. It also checked its JSON journal for that value. Exported observations contain no UI text. This deliberately reduces semantic richness and does not establish general redaction for all apps. Password fields that hide readback can produce `input_unverified`, which must remain inconclusive until some other authorized outcome can be observed.

Screenshots can expose private input, keyboard suggestions, device identifiers, and other apps. No pixel redaction is claimed. PNGs were captured locally, their hashes recorded, and raw PNGs purged after verification. Android diagnostic contents were not retained. Earlier synthetic test values were disposable; the cold emulator restart cleared that diagnostic buffer without deleting unrelated app data. The prototype does not promise to clean logs emitted independently by a target app or input method.

The helper uses the platform screenshot API without bypassing secure-window restrictions. Android's [FLAG_SECURE contract](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_SECURE) restricts screenshot visibility. A returned PNG alone does not prove a required outcome is visible. Production assessment must treat a blank, obscured, or unavailable required outcome as inconclusive. There was no authorized secure-window target or fixture in this environment, so this path was not proved.

## What T3 Code reuses

The investigation inspected the local T3 source checkout, the installed agent-device 0.21.25 package, and current upstream source. Upstream T3 was pinned at `701fc83169611473139c441bc27d5ded9612dc8d`; agent-device at `f2e74d237ae6f60dd8970dad1b7c70b17235e1d0`. The current [T3 tool version file](https://github.com/pingdotgg/t3code/blob/701fc83169611473139c441bc27d5ded9612dc8d/apps/server/src/device/deviceToolVersions.json) pins `expo-device-hub` 0.15.3 and `agent-device` 0.21.25, matching this environment's live device inventory. The older local source checkout pinned a different agent-device version, so it was not used as evidence for the current version.

T3 separates screen streaming from semantic automation. Its environment server supervises `expo-device-hub`, while Callstack's `agent-device` owns automation. Both are installed at pinned versions after their respective consent steps. A `DeviceHost` service handles local and SSH hosts. The hub stays on loopback behind an authenticated, allowlisted proxy; its unrestricted action routes are not exposed directly. T3's MCP entry points discover, open, screenshot, and close devices; actual agent interaction goes through the CLI. These decisions are documented in [T3's device internals](https://github.com/pingdotgg/t3code/blob/701fc83169611473139c441bc27d5ded9612dc8d/docs/internals/devices.md).

The [agent CLI shim](https://github.com/pingdotgg/t3code/blob/701fc83169611473139c441bc27d5ded9612dc8d/apps/server/src/device/AgentDeviceShim.ts) rejects noninformational commands lacking both `--config` and `--session`. It removes ambient daemon endpoint variables before launching the pinned CLI. [AgentDeviceTarget](https://github.com/pingdotgg/t3code/blob/701fc83169611473139c441bc27d5ded9612dc8d/apps/server/src/device/AgentDeviceTarget.ts) derives a session name from thread, host, and device identity, and atomically writes private endpoint configuration with mode 0600. This is a useful precedent for host and session binding. It is not evidence of Contingency's Run authorization policy.

Callstack's [Android snapshot helper](https://github.com/callstack/agent-device/blob/f2e74d237ae6f60dd8970dad1b7c70b17235e1d0/android/snapshot-helper/README.md) is already a separate instrumentation APK. It retrieves interactive windows, including IME and overlays, emits capture completeness metadata, supports a persistent loopback session with correlated requests, and publishes an APK manifest with a checksum and runner identity. Its one-shot and persistent modes cover snapshots, viewport, and planned gestures. npm packages bundle the APK; helper-backed snapshots install a missing or outdated helper automatically. Those mechanics are reusable candidates, but Contingency must obtain explicit installation authority and preserve its own fail-closed observation requirements.

Callstack also has a separate [Android IME helper](https://github.com/callstack/agent-device/blob/f2e74d237ae6f60dd8970dad1b7c70b17235e1d0/android/ime-helper/README.md) for Unicode text entry. It changes the device's active IME and restores the prior one through persisted lifecycle state. Its broadcast transport carries base64 text in ADB arguments. Base64 is reversible encoding, so this route cannot be treated as secret-safe command evidence without a separate audit and transport policy. This prototype kept the existing IME and used semantic field input instead.

The recommendation is to evaluate agent-device's typed Node backend behind Contingency's Effect services and evaluate expo-device-hub for Workspace mirroring. Reuse their device discovery, multi-window capture, packaging, and streaming work where the accepted contract permits it. A direct unrestricted CLI handoff would allow actions outside Contingency's app boundary and evidence rules. Adoption or a helper fork requires an explicit compatibility decision about ADR 0058's Contingency-owned protocol, not a silent replacement in this feasibility issue. No T3 or Callstack automation journey was executed as part of this prototype proof.

## Blockers and bounded follow-up work

Physical-device proof is blocked by the empty physical inventory from `adb devices -l` and T3 `device_list`. Multiple-device routing is supported structurally by explicit `-s`, but live proof is blocked by the absence of a second attached, authorized device. A stopped second AVD was discovered and was not booted without selection. Neither result can be substituted with emulator or mocked evidence.

Necessary system dialogs remain unsupported. Ordinary Settings dialogs were observed, but no authorized target in this proof triggered an OS permission dialog. Secure-window outcome proof also lacks a prepared target. Other Android APIs and OEMs, password readback, duplicate or missing resource IDs, coordinate animations, and multi-window occlusion require separate device coverage.

Production work can be split into these bounded deliverables:

1. Evaluate the pinned agent-device backend against this report's privacy, ownership, capture-completeness, stale-target, and physical-device cases. Decide whether to adapt it, fork its helper, or retain a Contingency helper. Record that decision before production integration.
2. Add an Android factory implementing the existing Platform Runtime lifecycle and capability contracts. Preserve device, helper session, observation, foreground-window ownership, capture integrity, and cancellation outcomes as typed data. Negotiate required extensions explicitly.
3. Package a signed, versioned helper with checksums and an explicit installation grant. Validate target package and build identity, record environment differences, and implement baseline or physical setup prerequisites. Permission cannot waive preparation failures.
4. Integrate Workspace mirroring and input routing with Run-scoped app permission, Confirmation, private Variable entry, incomplete Teaching termination, evidence intervals, and sensitive Cleanup. Evaluate T3's proxy and host-isolation approach for the stream service.
5. Add the React Native checkout fixture and end-to-end recipes, including a changed successful build, a deliberately broken build, system dialogs, secure windows, capture loss, and separate authorized physical-device coverage.

## Validation and cleanup

The helper build succeeded through `nub packages/cli/prototypes/android/build-helper.ts`. Prototype typechecking passed. Fourteen protocol tests passed, covering startup requirements, compatibility and correlation, private action records, stale-target refusal, failures and recovery, unauthorized launch, concurrent dispatch, and idempotent close. These are protocol tests, not substitutes for device evidence.

`nub exec turbo run quality` and `nub exec turbo run check-types` passed. Workspace Teaching and checkout recipes were not run or claimed. The prototype used verify-contingency's isolated artifact location and sensitive-evidence conventions without launching the product's Workspace processes.

Cleanup uninstalled only `dev.contingency.probe`, stopped the emulator process launched for this proof, removed the prototype's forwards and host locks, and purged raw PNGs after recording their hashes. It did not reset Settings, Chrome, the user's catalog, or unrelated forwards. The committed receipt records the final cleanup commands and outcomes.
