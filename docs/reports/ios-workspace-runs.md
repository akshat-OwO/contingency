# iOS Workspace journeys on the selected simulator

[ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md) binds Teaching and Runs to the selected running iPhone simulator. [ADR 0067](../adr/0067-runtimes-trade-privacy-and-app-boundaries-for-reach.md) defines Variable input and Confirmation. Public iOS MCP remains gated with `ios_support_matrix_unproven`.

## Runtime and Workspace

The internal Workspace lists stopped simulators but disables them, with instructions to start in Simulator and refresh. This matches Android's stopped-emulator policy. The `.app` path is optional. Naming a build adds a separate App installation decision before preparation, as Android does for an APK. With no path, preparation uses the app already installed on the selection. `restart-app` preparation terminates and launches the Target App, retaining its existing data and permission state. Contingency never creates, clones, resets, boots, shuts down, or deletes simulators. Closing a session stops its private runner and stream and leaves the selected simulator running.

Return to Target App validates the same selected UDID and SDK session and calls `apps.open` with `relaunch: false`. It preserves the signed-in screen and Teaching interval. Observation uses `observeOnly` and refuses Settings or another foreground app with `foreign_app_foreground`. Recovery brings the existing Target App forward. Transport recovery alone restarts the stream. Three post-action captures withhold the two stale fixture trees previously measured during the Settings handoff; any refusal stops immediately.

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
