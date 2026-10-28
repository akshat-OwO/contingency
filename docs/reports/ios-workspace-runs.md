# iOS Workspace Teaching and Runs

**Status: blocked; #548 is not complete.** The AX authority rejects Settings and permits explicit recovery on the same Session Simulator, but a fresh main journey paused on `ownership_unknown` at its first public input. The Support Matrix remains deferred to #550.

Issue #548 adds an internal iOS Workspace on top of #552, #554 and #558. iOS remains unlisted pending #550. The public-input proof uses iPhone 17 Pro with iOS 26.5 and a disposable UIKit version of the Android login fixture.

## Implementation and gates

`CONTINGENCY_IOS_WORKSPACE_INTERNAL=1` enables the Workspace entry and its private verification RPCs. The default UI has no iOS entry, discovery returns no devices through that entry, and public device MCP always returns `ios_support_matrix_unproven`, including with the internal gate enabled. The verification harness uses internal Workspace commands for agent actions and public MCP for recording claims, Timeline readback and Flow Skill learning. This gate is a development entry, not a Support Matrix claim.

Preparation creates a new Session Simulator from the selected template's device type and runtime. Input and the framebuffer helper bind that exact UDID. Stock pinned agent-device runs in a private state directory and socket daemon; it does not adopt the T3 daemon. Input uses fresh semantic references, session authority, app ownership checks and explicit preparation/recovery. Snapshots use the SDK’s `observeOnly` mode and reject activation metadata, so checking a session cannot reactivate its app over another app. Private Variables remain `capability_missing`; there is no private text transport or iOS Back control.

The opt-in build `CONTINGENCY_BUILD_IOS_FRAMEBUFFER=1` packages the Contingency-owned Objective-C source into `dist/ios/framebuffer`, ad hoc signs it, verifies its signature, and records source and executable SHA-256 hashes, host architecture and protocol version. Runtime validates the manifest and executable digest before spawning it. Ordinary builds need no Xcode and contain no executable iOS backend. Developer ID signing, notarization and clean-host proof remain #550 exit criteria.

The helper exposes pixels only. The session's authenticated view-only route validates session, credential, Host, Origin, method and path, has a bounded queue and revokes credentials at close. Transport failure pauses input and invalidates active capture. The manifest records the retained Start-to-Stop sample interval, output continuity and explicit gaps. It makes no claim that every compositor source frame was observed. Static displays remain valid; Start excludes queued earlier samples; Stop closes retention before durable finalization. Helper and Node use the same monotonic clock, including host sleep.

Rotation continues the same Teaching recording. A pick against incompatible fresh dimensions returns “The stream size or orientation changed. No input was sent.” The user picks again. Rotation alone does not make the recording incomplete. For display replacement, the parent resolves only the unique active integrated display of the same bound Session Simulator. The helper rebinds only that exact positively identified display. Unknown or ambiguous identity stops mirroring and pauses on typed `ownership_unknown`; it never chooses a largest surface or another simulator.

## Foreground ownership qualification

The stock XCTest `appState` and observe-only tree cannot establish visible ownership. The runner contains an internal active-application PID query, but the pinned public command protocol exposes no read-only query for that value. Its documented meaning is active accessibility sessions, without ordering or bundle identity. No pinned agent-device source was changed.

Qualification used an owned iPhone 17 Pro on iOS 26.5, UDID `37C7B399-B67E-4A27-9A46-61EE16FA6F44`. The shared device panel did not discover that new UDID. The probe therefore used an isolated stock runner state directory and exact-UDID Simulator commands, preserving the T3 daemon. The following table records settled cases. Screenshots pair Settings, Safari, Home and Control Center with the queries; the stock alert-wait command establishes the notification dialog. Immediate post-command samples remain in the evidence and do not establish that a transition completed.

| Candidate | Target | Settings | Safari | Notification alert | Home | Control Center | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `launchctl list` | Target PID present | Target PID still present | Target PID still present | Target PID still present | Target PID still present | Target PID still present | Process liveness only; rejected |
| `notifyutil -g com.apple.springboard.frontmostApp` | 0 | 0 | 0 | 0 | 0 | 0 | No owner identity; rejected |
| `SBSCopyFrontmostApplicationDisplayIdentifier` | null | null | null | null | null | null | Symbol loads but supplies no owner; rejected |
| AXRuntime `AXElement.primaryApp` | Target PID and bundle | Preferences PID and bundle | Safari PID and bundle | SpringBoard PID and bundle | SpringBoard PID and bundle | SpringBoard PID and bundle | Implemented; settled cases pass, full qualification blocked |

The stock app-switcher command returned success, but both screenshots still showed the Target App. That case was not reached and remains unqualified for every candidate. An immediate Safari transition supplied its PID with no bundle identifier, so the authority must reject it. Immediate Settings and Home samples still named the target before the settled checks. Settings remains correctly identified even with the Target App named in its return-to-app status-bar control. The paired settled screenshots and queries distinguish those cases; the probes do not establish atomic ownership through a transition. Unified scene logs showed activation and keyboard-focus events, but a historical event has no current-state checkpoint or loss guarantee, so logs were not used as an authority or sampled across the matrix.

Contingency owns a small read-only guest helper under `packages/cli/ios/foreground`. It reads the primary AX application twice and requires an unchanged positive PID and nonempty bundle identifier. The reply includes the guest's own Simulator UDID and protocol version. The helper requires existing automation access, never enables it, and never activates an app. Missing selectors, unavailable identity, disagreement and native exceptions fail without diagnostics. A four-second guest watchdog bounds a blocked AX call; the Effect caller has a five-second deadline.

The iOS service validates the reply schema, exact bound Session Simulator UDID and Target App bundle identifier on every check. It retains no successful ownership cache. Every authority error, including an invalid helper artifact, becomes typed `ownership_unknown`. Existing app-state and alert checks remain extra refusals. The helper has a separate versioned manifest, source and executable SHA-256 digests, and a verified ad hoc signature. Both final artifact digests match their source and executable. These settled observations do not qualify a stable Apple API or the #550 Support Matrix. The fresh journey failure below prevents full local acceptance.

Raw candidate results, paired screenshots, probe sources, final build digests and resource ownership are retained under `artifacts/ios-workspace-runs/` as `ownership-candidates.json`, `ownership-build.json` and `ownership-resources.json`.

## Verification

The earlier public journey passed on macOS 27.0.1 (26A434), arm64, Xcode 27.1 (27A9275), iPhone 17 Pro / iOS 26.5:

| Acceptance item | Result |
| --- | --- |
| Workspace Teaching and rotation | Passed; same recording, stale-size refusal, four semantic actions |
| Flow Skill learning | Passed through public claim, Timeline and save MCP |
| `working` Dry Run | Passed on a fresh Session Simulator |
| Verification and purge | Passed; saved marker read back, capture directory absent |
| Later `working` Run | Passed on another fresh Session Simulator |
| Default unlisted gate | Passed; no iOS button, disabled entry, empty discovery/session lists |
| Public MCP iOS refusal | Passed, including with the internal entry enabled |
| Duplicate binding, Takeover, coordinates, Back, Private Variables, edge swipe | Passed live |
| Real system alert | Notification dialog observed; `ownership_unknown` pause passed |
| Other app | Passed with AX authority; Settings pauses on `ownership_unknown`, then explicit recovery retains the same UDID |

A normal SDK snapshot initially reactivated the target app after Settings opened. `observeOnly: true` prevents that activation, but the SDK still returns the target app's `runningForeground` state and accessibility tree while Settings is visibly in front. The new AX authority closes that settled-state failure. The inherited final limits proof exited successfully with no blockers, including real notification-alert and Settings pauses, positive Target App ownership after same-device recovery, mid-recording helper loss and recovery. Its receipt is preserved as `ownership-inherited-limits.json`.

The takeover instance used a newly created shutdown iPhone 17 Pro / iOS 26.5 template, `13B2A615-D847-4CB8-BCFE-658505A09827`. Its main journey failed at the first `browser ios-pick` for `Login name`, after preparation and Start recording. The screenshot shows the Target App while the service reports `ownership_unknown`. The current error does not distinguish the AX query from other observation guards, so the failing guard is not isolated. No retry or relaxed ownership check was added. `takeover-main-receipt.json`, `takeover-main-blocked.png`, and `takeover-main.log` retain the failure. Earlier successful main journeys remain historical evidence, not a pass for this attempt.

The fresh slow-consumer proof passed with no blockers. Its authenticated stalled viewer produced an incomplete capture with a `slow-consumer` gap, recorded in `slow-consumer.json`. The limits and helper-loss/recovery results come from the inherited successful final run; they were not repeated after instance cleanup. A complete fresh main journey and fresh limits rerun remain required. Display-port replacement, live Stop races and complete source consistency remain unproved.

Evidence is under `.cursor/skills/verify-contingency/artifacts/ios-workspace-runs/` and contains only the public fixture journey. The recipe is `features/workspace.md#ios-workspace-internal` in verify-contingency.

## Checks

Each heavy command ran separately after a memory/swap check. Swap stayed at 1,083.5 MiB used in the recorded checks; no memory-pressure expansion was needed.

| Final command | Result |
| --- | --- |
| `CONTINGENCY_BUILD_IOS_FRAMEBUFFER=1 nub exec turbo run build --filter=@contingencyhq/cli --force` | 1/1 task passed; both ad hoc helpers built and signatures verified |
| `nub exec turbo run quality` | 2/2 tasks passed; 0 warnings, 0 errors; 731 linted and 982 formatted files |
| `nub exec tsc --noEmit -p packages/cli/tsconfig.json` | Passed; 0 errors |
| `nub exec tsc --noEmit -p apps/web/tsconfig.json` | Passed; 0 errors |
| Affected service tests via `nub exec vitest run` in `packages/cli` | 163/163 tests passed in 11/11 files; 0 failed |

The affected files include the Settings-in-front service regression, blocked input and capture, same-device recovery, unknown and malformed ownership, virtual-time helper timeout, both helper artifacts, iOS preparation, display identity/orientation, stream integrity and artifact tampering, UIKit node interaction, shared native capture and runtime, Android Workspace regression, Flow Skill packaging, recording store and platform requirements. Live checks expose the remaining observation failure; unit results do not establish final journey acceptance.

## Remaining qualification

This issue proves the public journey on one local arm64 host. It does not establish the #550 matrix, private input, x64 execution, Developer ID signing, notarization or a clean host. Long-run CPU/RAM, macOS/Xcode combinations and composition consistency require qualification beyond this journey. The display selector and rebind preserve fail-closed identity, but a real physical display-port replacement must be separately demonstrated if the installed simulator cannot produce one. Unit continuity checks are not live replacement evidence.

## Resource cleanup

The resource ledger records owned templates, Session Simulator UDIDs, private daemon owners, helpers, verification processes and listeners. Every simulator is deleted by exact UDID; user-owned devices and T3 services are preserved. Final audit: 30 owned simulator UDIDs are absent, including the template; 97 recorded PIDs were checked, with no owned process remaining; all 38 recorded listener ports are closed. No Session Simulator ownership marker remains. The temporary fixture build was removed. The three baseline user simulators remain shutdown. T3 and shared CoreSimulator services were preserved. Full identifiers and checks are in `resources.json` and `cleanup.json`; no cleanup failure was observed.

## Takeover cleanup audit

PID 18876 was awaited through a kernel process-exit event and exited successfully, without signaling it. Its wrapper also exited. PID 70757 was checked against its October 28 14:13:35 start time and exact driver command before `control-contingency cleanup` stopped the inherited instance. The inherited Session Simulator `8CDC2678-8008-4DB2-90E4-26DB2D816CDC` was already absent after scoped cleanup. Only the recorded owned shutdown template needed explicit deletion.

Both verification instances are cleaned. The final audit checked 1,123 recorded process identities, 17 owned simulator UDIDs and 26 listener ports. No recorded process, owned simulator, listener or ownership marker remains. Probe sources and public fixture screenshots were copied to `ownership-research/` under the artifacts directory before `/tmp/contingency-ios-548-ownership/` was removed. `ownership-cleanup-inherited.json` and `ownership-cleanup-final.json` retain the audit. User-owned simulators and T3 services were preserved. Evidence is local and gitignored.
