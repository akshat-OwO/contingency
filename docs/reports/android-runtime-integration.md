# Experimental Android runtime integration

Issue #468 implements the runtime portion of the stock agent-device direction selected in merged PR #472. The maintainer confirmed this narrower scope in the [issue comment](https://github.com/akshat-OwO/contingency/issues/468#issuecomment-6138280768). Private Variables, coordinate input, and a Contingency helper fork remain deferred. This change does not complete #457 or expose Android Teaching in Workspace.

## Runtime and ownership

`PlatformRuntimeFactory` now has typed web and Android factories and a discriminated startup request. The production service layer registers both. Browser Agent Sessions select the web extension and preserve browser session ownership, Emulation, and requirement checks. Android requirements still refuse browser Agent Session startup. The Android extension owns its selected device, SDK session, observations, and scoped cleanup without browser URLs, tabs, or session IDs.

Android startup requires an explicit local emulator serial, AVD name, API 36, build fingerprint, and Target App package. The runtime validates the same identity before capture and dispatch. It attaches to the prepared foreground environment without launching or resetting the Target App. It never selects another device or provisions one. Physical devices and remote hosts are unsupported in this experiment.

The runtime advertises semantic actions and screenshots. Other required capabilities fail before backend acquisition. Public ASCII text is supported only on an editable, uncovered, non-password target belonging to the declared app. Private Variables, arbitrary keys, coordinates, system-dialog actions, and Teaching capture fail explicitly.

Every action consumes its observation before backend validation or input. The adapter uses the stock generation-pinned references and serializes observation, input, recovery, and close with Effect and Effect Atom. Successful dispatch remains uncertain until a separate observation. Failure or interruption pauses the runtime and invalidates outstanding observations. Explicit recovery revalidates the selected device, helper, SDK session, and foreground owner. Recovery closes and reopens only the owned SDK session before taking fresh evidence. It does not repeat the failed action.

The stock SDK's snapshots omit the `identifiers` field declared in its published TypeScript contract. The adapter checks its owned SDK session against the selected serial and checks any identifiers that the operation actually returns. `backendSessionId` identifies that SDK session. It is not an authenticated helper protocol identity.

## Helper and sensitive evidence

The CLI pins and vendors unmodified agent-device 0.21.25, including its bundled helper and MIT license. The adapter validates the package version, helper release manifest, and APK SHA-256 before use. Exact installed APK bytes bind both the published payload and its signer. The [receipt](android-runtime-evidence.json) records the independently inspected signing certificate digest and release identity.

A missing or different installed APK requires an installation grant naming the selected serial, exact APK checksum, and either installation or replacement. Recovery refuses a missing helper rather than automatically reinstalling it. An authorized installation persists beyond the session. Runtime cleanup never uninstalls a preexisting helper.

Each runtime creates a private daemon directory and unique SDK session, with a per-serial Contingency lock. Daemon credentials remain in that private directory. The adapter uses the public Node client and official daemon CLI, and clears ambient agent-device configuration when launching its daemon. It does not depend on the user's T3 installation. Cleanup closes the owned session and daemon, purges local session files, and releases the acquired lock. A cleanup failure retains owned state for inspection and appears in the terminal runtime state.

Screenshots and SDK diagnostics remain sensitive local evidence. The production error contract contains fixed messages and an allowlist of backend reasons, not SDK errors or command output. The public text path makes no secret-input guarantee. Downstream integrations must not resolve private Variables into that path.

## Evidence and limits

The 2026-10-13 proof used the explicitly authorized Pixel_9 API 36 emulator at `emulator-5554`. The [sanitized receipt](android-runtime-evidence.json) includes observation IDs, helper identity, screenshot hashes, refusals, and cleanup. Raw screenshots and SDK files were purged from owned temporary state.

Live production-runtime proof passed:

- Explicit device identity and helper installation consent, including startup refusal without an installation grant.
- Semantic Device name dialog input, independent public-text readback, stale-observation refusal, coordinate refusal, and fresh recovery. Cancel dismissed the editor without saving. Independent device-name readback remained `sdk_gphone64_arm64`.
- Helper removal after this proof installed it, paused observation, authorized reinstallation, and recovery with fresh evidence.
- Device disconnect, invalidation, refusal to recover while offline, and recovery after the same AVD, serial, API, and fingerprint were revalidated.
- Idempotent close, no remaining helper process or ADB forwards, and removal of owned daemon and media directories.

The browser regression proof followed verify-contingency's Workspace and saved Emulation conventions. It passed recorded canvas input, learning, a fresh Dry Run, Workspace verification, persisted web runtime and Emulation metadata, and a later fresh Run of the verified skill. Verification purged the recording. The isolated browser catalog and processes were cleaned up. Collaborative Preview failed twice with `Preview automation snapshot timed out after 15000ms.` The skill's browser driver supplied the retained ARIA and screenshots.

Validation passed `nub exec turbo run quality`, `nub exec turbo run check-types`, the CLI production build, and the Android runtime, browser runtime, and Agent Session service tests. The real browser runtime and Teaching Emulation integration files passed five consecutive runs each.

The following remain separate coverage limits:

- Cancellation, concurrent dispatch, incomplete capture, unknown ownership, and cleanup failure have deterministic service-test coverage. Secure-window visibility and necessary system dialogs have no live qualification.
- An earlier live Settings search action transitioned to `com.google.android.settings.intelligence`. The runtime paused with `ownership_unknown`. That investigation is separate from the retained Device name proof.
- No physical device was attached or authorized. The second AVD remained stopped, so multiple-device behavior has no live qualification.
- Ownership checks are experimental host checks. Stock dispatch is not an atomic app-authority check, and stock internal retries remain upstream behavior. Contingency does not add automatic replay or claim stronger guarantees.
- Stock semantic snapshots and screenshots are separate captures. They are not a synchronized Teaching interval or proof that a secure or obscured outcome is visible. Required unavailable evidence remains inconclusive.
- Preparation, execution permission UI, mirrored Workspace Teaching, Android Flow Skill learning, and the complete checkout fixture remain downstream work. Their absence blocks an advertised Android release, not this internal runtime deliverable.

## Reproduction entry points

`packages/cli/scripts/verify-android-runtime.ts` requires explicit `CONTINGENCY_ANDROID_SERIAL`, `CONTINGENCY_ANDROID_AVD`, `CONTINGENCY_ANDROID_FINGERPRINT`, `CONTINGENCY_ANDROID_HELPER_GRANT`, and `CONTINGENCY_ANDROID_EVIDENCE_DIRECTORY`. The helper grant is `install`, `replace`, or `none`. The `install` proof requires the helper to be absent and also exercises removal and reinstallation of that proof-owned package. A prepared Settings Device name page supplies the reversible dialog; the runner cancels the edit.

`packages/cli/scripts/verify-android-disconnect.ts` uses the same selection and evidence variables with an already installed compatible helper. It stops only the selected emulator. After writing `disconnect-paused.json`, it waits for a `recovery-ready` filesystem event. The operator restarts that same authorized AVD, revalidates identity, prepares Settings, and writes that marker. The runtime then performs explicit recovery and writes `disconnect-recovered.json`. Neither runner starts another device or exports screenshot pixels.
