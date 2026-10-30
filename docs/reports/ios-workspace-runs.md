# iOS Workspace journeys on the selected simulator

[ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md) binds Teaching and Runs to the selected running iPhone simulator. [ADR 0067](../adr/0067-runtimes-trade-privacy-and-app-boundaries-for-reach.md) defines Variable input and Confirmation. These historical receipts used the internal gate. iOS is now listed after the [Support Matrix proof](ios-support-matrix.md).

## Runtime and Workspace

The internal Workspace lists stopped simulators but disables them, with instructions to start in Simulator and refresh. This matches Android's stopped-emulator policy. The `.app` path is optional. Naming a build adds a separate App installation decision before preparation, as Android does for an APK. With no path, preparation uses the app already installed on the selection. `restart-app` preparation terminates and launches the Target App, retaining its existing data. Permission states are retained unless the environment declares them; declared states are applied between terminate and launch. Contingency never creates, clones, resets, boots, shuts down, or deletes simulators. Closing a session stops its private runner and stream and leaves the selected simulator running.

Return to Target App validates the same selected UDID and SDK session and calls `apps.open` with `relaunch: false`. It preserves the signed-in screen and Teaching interval. Observation uses `observeOnly` and refuses Settings or another foreground app with `foreign_app_foreground`. Recovery brings the existing Target App forward. Transport recovery alone restarts the stream. Post-action capture accepts a new role/name pair immediately. Otherwise it makes up to three captures, withholding the two stale fixture trees previously measured during the Settings handoff; any refusal stops immediately. Missing nodes, geometry changes, and node generations do not prove screen progress.

A readable fill is `confirmed`; the secure `{{PASSWORD}}` fill is entered but `unconfirmed`. Learning saves the Variable reference. Android and iOS share `native-app-confirmation.ts`: irreversible actions require one-attempt Confirmation, Refuse dispatches nothing, and replay cannot dispatch twice.

## Proof contract

The maintained recipe is `.cursor/skills/verify-contingency/features/workspace.md#ios-workspace-internal`. The full proof uses one proof-owned simulator as the selected device, then deletes it by exact UDID after product cleanup. Product lifecycle code never owns that device. The receipt compares all simulator identities and states before and after product activity, including the selected UDID, which must remain running after sessions close.

One receipt must cover the public gate, Teaching, confirmed readable input, unconfirmed secure Variable input, learning, a working Dry Run, verification and purge, a later Run, the system alert, Confirmation Allow and Refuse, and Settings refusal followed by Return to Target App and continuation during both Teaching and the later Run. No assertion is relaxed for selected-device preparation.

Attempts 9 and 13 passed earlier implementations. Attempt 14 stopped at fixture setup because the Device panel did not list the newly created simulator. For this follow-up, attempts 15 and 16 were authorized. Attempt 15 passed the complete selected-device proof; attempt 16 was not needed.

## Limits

The Support Matrix remains unproven. This one-host iOS 26.5 proof cannot establish iOS 27.1, rotation, display replacement, Stop races, x64, signing, notarization, clean-host qualification, or an arbitrary-duration foreground-ownership guarantee. Other-app observation remains a documented SDK limit.

## Selected-device verification results

Attempt 15 passed on iOS 26.5 with iPhone 17 and `CONTINGENCY_IOS_WORKSPACE_INTERNAL=1`. The production CLI and optional framebuffer helper were rebuilt from `e8dac1e3` before the proof. The journey ran from 2026-10-29 09:25:03 UTC to 09:28:10 UTC. No product bug blocked it and no product module changed.

The single receipt is `.cursor/skills/verify-contingency/artifacts/ios-selected-attempt15/receipt.json`, with no blockers. It covers the public gate, separate App installation decision, Teaching, learning, a `working` Dry Run, verification and purge, a later `working` Run, system alert Allow, Confirmation Refuse and Allow with replay protection, and Settings refusal followed by Return to Target App and continuation in both Teaching and the later Run. `timeline.json` records the readable fill as `confirmed` and the secure PASSWORD Variable as `unconfirmed`. Stream interval evidence has no gaps. Later sessions omitted the installation path and retained the existing-data sentinel.

The proof-owned UDID was `F7CA468E-8824-47EC-8314-055DD5D88244`. Every observed framebuffer bound that exact selection. The receipt's complete before/after inventories match, including that UDID in `Booted` state after sessions closed. All 12 pre-existing simulators remained unchanged. Thus product activity created and deleted no simulator.

The attempt-14 blocker was fixture setup routing through the Device panel. The maintained `bin/ios-workspace-attempt.sh` now owns direct exact-UDID create, boot, bootstatus, install, and teardown. `/tmp/ios-0067-live/scripts/attempt.sh` delegates to it. All UI actions still pass through Contingency. The proof inventory assertion was strengthened to include the selection. No assertion was weakened and no agent-device code changed.

Setup, launch, proof, memory, process, listener, and teardown evidence is under `/tmp/ios-0067-live/attempt15/`. The artifact directory retains the receipt, journal, Timeline, stream interval, screenshots, and ARIA snapshots. `state-evidence/` retains JSON readback from the isolated Catalog Root before cleanup. The ledger is `/tmp/ios-selected-sim-proof-resource-ledger.md`.

Cleanup passed in `attempt15/cleanup-audit.json`: all 17 tracked process identities exited, product ports 57941, 57977, 57982, and 57983 closed, no new listener remained, and the fixture and isolated instance were removed. Product cleanup finished before fixture teardown shut down and deleted only the exact proof-owned UDID. The post-teardown inventory exactly matches the pre-create baseline. The supplemental audit found no remaining product process. The T3-owned daemon was neither reused nor signaled; no Device panel session was opened. Memory stayed healthy, from 71% free before setup to a sampled minimum of 55%, then 65% after cleanup. Swap remained 1041.19 MB.

Fresh checks pass: `nub exec turbo run quality`, `nub exec turbo run check-types`, and `nub exec --cwd packages/cli vitest run`, all 818 tests in 105 files. Build and check logs are under `/tmp/ios-selected-sim-proof-checks/`. Type checks used the existing unchanged-source Turbo cache. The earlier integration run passed all 178 tests in 43 files; it was not repeated for these proof-only changes.

The required single live iOS 26.5 receipt is now complete. Separate preparation, limits, and slow-consumer helpers were not run. The broader Support Matrix and qualification limits above remain unproven, so public iOS MCP stays gated.

## Cheaper post-action capture

Attempt 12's stale Settings tree was not exactly equal to the pre-action tree: its redundant `text` node named Open account disappeared, while the button remained. Accepting any tree difference would expose that stale fixture screen. The runtime now accepts early only when a new role/name pair appears. Observation IDs, generations, references, bounds, order, and removals do not qualify. Otherwise it retains the existing three-capture bound and stops immediately on any refusal. No sleeps were added.

The changed-screen regression failed before implementation, returning capture 3 instead of capture 1. Unchanged-screen and handoff safety cases already passed against the previous mitigation. The missing-label case fails if any tree difference is accepted early. All 17 capture tests now pass, including unchanged/unchanged/refused and the missing-label reproduction. Logs are `/tmp/ios-capture-{red,green}.log`.

Attempt 16 stopped after Dry Run sign-in with `capture_incomplete`; its Teaching Settings tap refused correctly. The precise backend cause is unresolved. Attempts 4 and 6 hit the same code before this change, and the new captures are a prefix of the old three, so the change cannot add a capture. Its partial receipt is `artifacts/ios-capture-attempt16/receipt.json`. Attempt 17 passed the complete single-receipt contract on the same final implementation, without relaxing assertions. Its receipt is `.cursor/skills/verify-contingency/artifacts/ios-capture-attempt17/receipt.json`, with no blockers, from 2026-10-29 09:48:50.446 UTC to 09:52:03.242 UTC. It covers Teaching with `{{PASSWORD}}` unconfirmed, learning, a working Dry Run, verification/purge, the later working Run, system alert, Confirmation, and both Settings refusal/recovery/continuation paths. The complete product before/after simulator inventories match and the selected simulator remains Booted after sessions close. No product simulator was created or deleted.

### Timing comparison

The table compares each Teaching action's before/after observation timestamps, in milliseconds. This measures dispatch plus post-action capture after the before screenshot, not complete tap latency. Attempt 15 did not record ordinary command start/end times. These are individual live samples; host and SDK variance remain visible.

| Teaching action      | Attempt 15 | Attempt 16 | Attempt 17 |
| -------------------- | ---------: | ---------: | ---------: |
| Readable fill        |       5886 |       3835 |       7599 |
| Secure PASSWORD fill |       7546 |       5645 |       7187 |
| Sign in privately    |       3738 |       1925 |       2494 |
| Open account         |       3647 |       1455 |       2050 |
| Return to account    |       3855 |       1576 |       2037 |

Attempt 17's navigation intervals decreased 33–47% against attempt 15. Fills are mixed: a fill keeps the field's role and name, so it still pays for three captures. The complete proof took 192.796 seconds versus attempt 15's 186.994 seconds; this is not evidence of a faster whole journey.

The new receipt records all internal input RPC durations, including refused/duplicate attempts; the journal records mirror commands. For attempt 17's ordinary Dry Run actions, input RPC durations were 5640, 5760, 3598, 3040, and 2981 ms in journey order. The later Run's five were 5212, 5515, 3549, 2907, and 2883 ms. Settings taps retained refusal: Teaching was 5133 ms in attempt 15 and 7709 ms in attempt 17; later Run was 2400 ms and 2374 ms. Protection remains bounded, not a guarantee of arbitrary-duration XCTest foreground correctness.

Raw comparison data is `/tmp/ios-capture-timings.json`. Each action interval comes from the retained `timeline.json`; command timings are in attempt 17's `receipt.json` and `journal.json`. Full host evidence is `/tmp/ios-0067-live/attempt{16,17}/`. Both cleanup audits pass, with 18 and 25 tracked process identities exited, all four instance ports closed, no new listeners, exact original simulator inventories restored, and owned fixture/instance removed. Teardown deleted only each launcher's exact proof-owned UDID after product cleanup. The T3 daemon and all pre-existing simulators were preserved.

## Declared starting permission states

The iOS environment may carry `permissions`, a list of `{ decision: "grant" | "revoke" | "reset", service }`, in the same field Android uses for its starting permission decisions. The Teaching selection becomes the taught environment, so saved requirements record the declaration. A Run whose declaration differs from the taught one shows a `permissions` difference and needs Run Environment Permission. Preparation runs `xcrun simctl privacy <selected UDID> <decision> <service> <Target App bundle>` for each entry, after any install and terminate and before launch. Supported services are those `xcrun simctl help privacy` lists on Xcode 27.1, except the bundle-wide `all`: calendar, contacts-limited, contacts, location, location-always, photos-add, photos, media-library, microphone, motion, reminders, and siri. Notifications and camera are not available. An unsupported or repeated service fails with `permission_service_unsupported` before inventory reads or device commands.

Attempt 18 passed on iOS 26.5 with iPhone 17, from 2026-10-29 10:09:12 UTC to 10:12:23 UTC, on proof-owned UDID `8296CEA7-F0A6-4796-9D93-66ACE3A5DDBA`. The receipt is `.cursor/skills/verify-contingency/artifacts/ios-permissions-attempt18/receipt.json`, with no blockers. It contains the full earlier journey and `coverage.declaredPermissionState`. Teaching and the Dry Run started on **Photos access: not determined**. The later Run declared `photos` revoked, showed the `permissions` difference in its Run Environment Permission prompt, and after **Allow** and preparation first observed **Photos access: denied**, without a Settings visit. Its cleanup audit passed; attempt 19 was not needed.

## Passive app-state capture recovery

Issue #581's retained failures have different histories. Attempt 4 failed on Teaching sign-in before the truncated-tree fix. Attempt 6 failed on the notification alert before the presented-viewport fix. Attempt 16 failed on Dry Run sign-in, but its retained error is still only `capture_incomplete`. The SDK error formatter added in 5461f610 did not name local validation failures, so those artifacts cannot identify attempt 16's exact check.

A production drive on iOS 26.5 reproduced `capture_incomplete` on the first Teaching **Sign in privately**, before the repeat loop. Capture attempt 12 completed its snapshot, screenshot, and app-state RPC, then rejected the app-state result as unverified. The capture took 3257 ms, including 2555 ms for the snapshot, 689 ms for the screenshot, and 8 ms for app state. There was no SDK rejection code or reason. The failure was the runtime's local `session-check`, not the 30-second deadline. Evidence is in `artifacts/ios-581-repro/` under the verification skill and `/tmp/ios-581-live/repro/verify/mcp.log`.

agent-device 0.21.25 documents app state as a passive read. Its Apple runtime returns no state without a live runner, and its command returns session metadata when the runner state is unavailable. It can also suppress a runner-read error into that fallback. The iOS runtime now withholds that acquisition as `observation_stale` and reacquires the complete tree, screenshot, and app-state sequence within the existing 30-second bound. It still requires verified foreground state before exposing an observation, refuses a known background state immediately, and never activates the app during observation. A persistent unverified state still ends in `capture_incomplete`.

The virtual-time regression failed before this change and passes after it. It covers a passive result followed by verified foreground; additional cases preserve refusal for persistent missing state and session metadata claiming foreground. Capture diagnostics now name local validation checks and record capture attempt numbers and per-step durations without captured content or raw SDK messages. The proof's `CONTINGENCY_IOS_SIGN_INS=30` mode repeats fresh Dry Runs after Teaching and learning, retaining stages, outcomes, errors, and timings in `sign-ins.json` before the original full journey.

The fixed production drive ran on iOS 26.5 with iPhone 17 from 2026-10-29 13:41:46 UTC to 13:55:41 UTC. All 30 fresh Dry Run sign-ins passed, followed by the complete proof in the same receipt with no blockers. It includes Teaching and learning, a working Dry Run, verification and purge, a working later Run, notification Allow, Confirmation Refuse and Allow with replay protection, declared Photos permission readback, Settings refusal and recovery in Teaching and Run, and all documented-limit checks. Evidence is in `artifacts/ios-581-fixed/receipt.json`, `sign-ins.json`, `timeline.json`, the journal, and screenshots. The fixed run did not encounter another passive app-state fallback; direct recovery evidence is the deterministic regression.

Both runs restored their original simulator inventory and closed all four instance ports. The fixed-run audit checked 156 recorded process identities, private daemon directory removal, and owned fixture removal; the event-driven resource observer also exited. Exact proof-owned UDIDs alone authorized teardown. No pre-existing simulator or T3 daemon was changed. Detailed local evidence and remaining limits are recorded in `/tmp/ios-581-report.md`.
