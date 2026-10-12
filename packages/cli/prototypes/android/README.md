# Run the isolated Android feasibility probe

This prototype accompanies [issue 463](https://github.com/akshat-OwO/contingency/issues/463). It does not register an Android runtime, expose production MCP tools, or integrate Workspace. Read the [feasibility report](../../../../docs/reports/android-driver-feasibility.md) for evidence and remaining blockers.

## Prepare the host and selected device

Use `nub` for TypeScript commands. Install JDK 17 or newer, Android SDK platform 36, and Android Platform-Tools. Set `ANDROID_HOME` to the SDK directory and put its `platform-tools` directory on `PATH`. The Gradle wrapper pins 9.3.1, Android Gradle Plugin pins 8.12.0, and UI Automator pins 2.3.0. The first build needs access to Gradle, Google Maven, and Maven Central.

The helper declares Android API 30 as its minimum. Only API 36 on the authorized Pixel_9 emulator has been exercised. Other versions and physical devices remain unverified.

List devices with `adb devices -l`. Obtain an explicit selection even when there is only one device. Set `PROBE_SERIAL` to its ADB serial, not its AVD name. Verify the selection with `adb -s "$PROBE_SERIAL" get-state`. For an emulator, read `adb -s "$PROBE_SERIAL" emu avd name` too. The runner never selects or switches devices for you.

Build from the repository root:

```sh
nub packages/cli/prototypes/android/build-helper.ts
```

After the user authorizes helper installation on that device, install the APK:

```sh
adb -s "$PROBE_SERIAL" install packages/cli/prototypes/android/helper/build/outputs/apk/debug/contingency-android-probe-debug.apk
```

Use `install -r` only when authorized to replace a previous copy of this helper. A production package needs a stable signing certificate. This feasibility build uses the local Gradle debug certificate.

## Capture and exercise Settings

The following example uses the unmodified Android Settings app. It opens a device-name editor and cancels it without saving a name. Inspect each captured tree and screen before choosing coordinates or resource IDs. Layouts differ between Android builds.

```sh
adb -s "$PROBE_SERIAL" shell am start -W -a android.settings.DEVICE_INFO_SETTINGS
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/emulator/observe
```

Each invocation owns one helper session and dynamically allocated ADB forward. It captures `before.json` and `before.png`. For a mutation, it also captures `after.json` and `after.png` when available. `journal.json` records outcomes and Variable references. `commands.json` records ADB lifecycle commands and success or failure, with the ephemeral authentication token replaced by a placeholder. Protocol responses containing screenshots never go into command journals.

On the verified Pixel_9 API 36 layout, the Device name row was at device pixel coordinates 400, 945:

```sh
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/emulator/coordinate coordinate 400 945
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/emulator/private private android:id/edit
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/emulator/cancel click android:id/button2
```

The private probe generates a disposable value internally. It verifies the field through `ACTION_SET_TEXT` and a helper-side readback, records only `PROBE_INPUT`, and checks recent Android diagnostics without retaining their content. No real credential is needed. Raw screenshots can contain the generated value. The probe does not change the active input method.

A dispatched action consumes its observation. Every mutation probe attempts to reuse the consumed observation and records its refusal. The helper checks a private semantic fingerprint before dispatch. Coordinate actions also require an identical screenshot and in-bounds coordinates. An animated screen can make coordinate fallback unavailable. Take a new observation after any failure.

## Exercise failures

Run these probes while Settings is in the foreground:

```sh
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/emulator/denied launch-denied
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/emulator/capture-failure capture-failure
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" com.android.settings .cursor/skills/verify-contingency/artifacts/android-463/emulator/helper-failure helper-failure
```

`launch-denied` refuses Chrome before transport dispatch. `capture-failure` explicitly arms the prototype-only capture fault and proves invalidation and fresh capture recovery. `helper-failure` force-stops only this helper. Restart with a new invocation and fresh observation.

The `cross-app` scenario launches Chrome with `am start -W` to simulate an external transition. It does not accept Chrome's onboarding or change its settings. Run it only if Chrome is installed and this test launch is authorized. Further observations and input fail while Chrome owns the foreground. Return to Settings explicitly before recovery.

The `capture-off` scenario switches the screen off, observes the failure, and wakes it. In this run, the foreground check refused keyguard ownership before screenshot capture. It does not prove secure-window behavior.

The `disconnect` scenario powers off the selected emulator with `adb -s SERIAL emu kill`. Use it only on an emulator you own for the proof. It never runs a physical-device reset. Restart that same selected emulator, revalidate its identity, and start a new helper session. The client never reconnects or replays an action automatically.

## Check authorized launcher visibility

Set `PROBE_TARGET` to an already-installed, authorized app with a launcher activity. Bring that app to the foreground through its known explicit component, then run:

```sh
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" "$PROBE_TARGET" .cursor/skills/verify-contingency/artifacts/android-463/emulator/launch launch-authorized
```

This scenario captures the target, returns Home, and requests launch through the helper. The after observation must identify the target. The manifest queries `MAIN/INFO` and `MAIN/LAUNCHER` activities so Android 11+ package visibility does not hide an eligible target. Visibility does not replace authorization.

The helper has no launcher activity. Use it as the declared test target to exercise the genuinely unavailable-launch path without installing another app:

```sh
nub packages/cli/prototypes/android/probe.ts "$PROBE_SERIAL" dev.contingency.probe .cursor/skills/verify-contingency/artifacts/android-463/emulator/no-launcher launch-unavailable
```

The journal must record `launch_unavailable`. This scenario performs the lookup without requiring a target observation first.

## Verify and clean up

```sh
nub exec tsc --noEmit -p packages/cli/prototypes/android/tsconfig.json
nub exec --filter @contingencyhq/cli vitest run prototypes/android/driver.test.ts
nub exec turbo run quality
nub exec turbo run check-types
```

Scoped finalizers close the helper, remove only their allocated forward, stop the owned helper process, and remove their exclusive per-device host lock. They refuse to adopt an already-running helper. After an uncatchable host crash, inspect the matching `contingency-android-probe-<sha256-of-serial>.lock` directory under the host temporary directory before removing it. Never remove a lock belonging to a live process.

If this proof installed the helper into a device where it was previously absent, uninstall it when done:

```sh
adb -s "$PROBE_SERIAL" uninstall dev.contingency.probe
adb -s "$PROBE_SERIAL" shell pidof dev.contingency.probe
adb forward --list
```

The `pidof` command should find no helper process. Unrelated forwards can remain. Do not remove them or reset target-app data. Record hashes and verification outcomes before purging raw PNGs and other sensitive media in this proof's artifact directory. Do not copy Android logcat, protocol payloads, or screenshots into GitHub comments or committed reports. The general verify-contingency `cleanup` command only owns its recorded Workspace processes; this prototype never launches those processes and uses its own scoped cleanup.
