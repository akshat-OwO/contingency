# iOS Workspace Teaching and Runs

**Status: blocked; #548 is not complete.** The other-app ownership acceptance item failed on the final revision.

Issue #548 adds an internal iOS Workspace on top of #552, #554 and #558. iOS remains unlisted pending #550. The public-input proof uses iPhone 17 Pro with iOS 26.5 and a disposable UIKit version of the Android login fixture.

## Implementation and gates

`CONTINGENCY_IOS_WORKSPACE_INTERNAL=1` enables the Workspace entry and its private verification RPCs. The default UI has no iOS entry, discovery returns no devices through that entry, and public device MCP always returns `ios_support_matrix_unproven`, including with the internal gate enabled. The verification harness uses internal Workspace commands for agent actions and public MCP for recording claims, Timeline readback and Flow Skill learning. This gate is a development entry, not a Support Matrix claim.

Preparation creates a new Session Simulator from the selected template's device type and runtime. Input and the framebuffer helper bind that exact UDID. Stock pinned agent-device runs in a private state directory and socket daemon; it does not adopt the T3 daemon. Input uses fresh semantic references, session authority, app ownership checks and explicit preparation/recovery. Snapshots use the SDK’s `observeOnly` mode and reject activation metadata, so checking a session cannot reactivate its app over another app. Private Variables remain `capability_missing`; there is no private text transport or iOS Back control.

The opt-in build `CONTINGENCY_BUILD_IOS_FRAMEBUFFER=1` packages the Contingency-owned Objective-C source into `dist/ios/framebuffer`, ad hoc signs it, verifies its signature, and records source and executable SHA-256 hashes, host architecture and protocol version. Runtime validates the manifest and executable digest before spawning it. Ordinary builds need no Xcode and contain no executable iOS backend. Developer ID signing, notarization and clean-host proof remain #550 exit criteria.

The helper exposes pixels only. The session's authenticated view-only route validates session, credential, Host, Origin, method and path, has a bounded queue and revokes credentials at close. Transport failure pauses input and invalidates active capture. The manifest records the retained Start-to-Stop sample interval, output continuity and explicit gaps. It makes no claim that every compositor source frame was observed. Static displays remain valid; Start excludes queued earlier samples; Stop closes retention before durable finalization. Helper and Node use the same monotonic clock, including host sleep.

Rotation continues the same Teaching recording. A pick against incompatible fresh dimensions returns “The stream size or orientation changed. No input was sent.” The user picks again. Rotation alone does not make the recording incomplete. For display replacement, the parent resolves only the unique active integrated display of the same bound Session Simulator. The helper rebinds only that exact positively identified display. Unknown or ambiguous identity stops mirroring and pauses on typed `ownership_unknown`; it never chooses a largest surface or another simulator.

## Verification

The final public journey passed on macOS 27.0.1 (26A434), arm64, Xcode 27.1 (27A9275), iPhone 17 Pro / iOS 26.5:

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
| Other app | **Failed: Settings remains visible while the session stays running** |

A normal SDK snapshot initially reactivated the target app after Settings opened. `observeOnly: true` prevents that activation, but does not solve ownership: the SDK still returns the target app's `runningForeground` state and its accessibility tree while Settings is visibly in front. The installed SDK explicitly describes `IosSnapshotObservation.appState` as “XCTest's report, not proof of foreground ownership.” The final screenshot `limit-blocked.png` and `limits.json` preserve this failed proof. Inferring ownership from that value would violate the required pause contract.

**Decision needed:** choose and qualify a positive foreground scene/window ownership authority for the bound Session Simulator. ADR 0066 requires fail-closed ownership but does not specify the additional authority when stock agent-device cannot establish it. No new ownership backend was guessed. Mid-recording helper loss/recovery and the slow-consumer live scripts remain unexecuted because the limits journey stops at the failed ownership item; their unit integrity checks pass. Display-port replacement, live Stop races and complete source consistency also remain unproved.

Evidence is under `.cursor/skills/verify-contingency/artifacts/ios-workspace-runs/` and contains only the public fixture journey. The recipe is `features/workspace.md#ios-workspace-internal` in verify-contingency.

## Checks

Each heavy command ran separately after a memory/swap check. Swap stayed at 1,083.5 MiB used in the recorded checks; no memory-pressure expansion was needed.

| Final command | Result |
| --- | --- |
| `CONTINGENCY_BUILD_IOS_FRAMEBUFFER=1 nub exec turbo run build --filter=@contingencyhq/cli --force` | 1/1 task passed; ad hoc artifact built and signature verified |
| `nub exec turbo run quality` | 2/2 tasks passed; 0 warnings, 0 errors; 727 linted and 977 formatted files |
| `nub exec tsc --noEmit -p packages/cli/tsconfig.json` | Passed; 0 errors |
| `nub exec tsc --noEmit -p apps/web/tsconfig.json` | Passed; 0 errors |
| Affected service tests via `nub exec vitest run` in `packages/cli` | 148/148 tests passed in 10/10 files; 0 failed |

The affected files cover iOS preparation, display identity/orientation, stream integrity and artifact tampering, UIKit node interaction, shared native capture and runtime, Android Workspace regression, Flow Skill packaging, recording store and platform requirements. Live checks, not these unit results, establish the successful journey and expose the ownership failure.

## Remaining qualification

This issue proves the public journey on one local arm64 host. It does not establish the #550 matrix, private input, x64 execution, Developer ID signing, notarization or a clean host. Long-run CPU/RAM, macOS/Xcode combinations and composition consistency require qualification beyond this journey. The display selector and rebind preserve fail-closed identity, but a real physical display-port replacement must be separately demonstrated if the installed simulator cannot produce one. Unit continuity checks are not live replacement evidence.

## Resource cleanup

The resource ledger records owned templates, Session Simulator UDIDs, private daemon owners, helpers, verification processes and listeners. Every simulator is deleted by exact UDID; user-owned devices and T3 services are preserved. Final audit: 30 owned simulator UDIDs are absent, including the template; 97 recorded PIDs were checked, with no owned process remaining; all 38 recorded listener ports are closed. No Session Simulator ownership marker remains. The temporary fixture build was removed. The three baseline user simulators remain shutdown. T3 and shared CoreSimulator services were preserved. Full identifiers and checks are in `resources.json` and `cleanup.json`; no cleanup failure was observed.
