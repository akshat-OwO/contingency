# iOS Workspace journeys on the selected simulator

[ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md) binds Teaching and Runs to the selected running iPhone simulator. [ADR 0067](../adr/0067-runtimes-trade-privacy-and-app-boundaries-for-reach.md) defines Variable input and Confirmation. Public iOS MCP remains gated with `ios_support_matrix_unproven`.

## Runtime and Workspace

The internal Workspace lists stopped simulators but disables them, with instructions to start in Simulator and refresh. This matches Android's stopped-emulator policy. The `.app` path is optional. Naming a build adds a separate App installation decision before preparation, as Android does for an APK. With no path, preparation uses the app already installed on the selection. `restart-app` preparation terminates and launches the Target App, retaining its existing data and permission state. Contingency never creates, clones, resets, boots, shuts down, or deletes simulators. Closing a session stops its private runner and stream and leaves the selected simulator running.

Return to Target App validates the same selected UDID and SDK session and calls `apps.open` with `relaunch: false`. It preserves the signed-in screen and Teaching interval. Observation uses `observeOnly` and refuses Settings or another foreground app with `foreign_app_foreground`. Recovery brings the existing Target App forward. Transport recovery alone restarts the stream. Three post-action captures withhold the two stale fixture trees previously measured during the Settings handoff; any refusal stops immediately.

A readable fill is `confirmed`; the secure `{{PASSWORD}}` fill is entered but `unconfirmed`. Learning saves the Variable reference. Android and iOS share `native-app-confirmation.ts`: irreversible actions require one-attempt Confirmation, Refuse dispatches nothing, and replay cannot dispatch twice.

## Proof contract

The maintained recipe is `.cursor/skills/verify-contingency/features/workspace.md#ios-workspace-internal`. The full proof uses one proof-owned simulator as the selected device, then deletes it by exact UDID after product cleanup. Product lifecycle code never owns that device. The receipt compares unrelated simulator identities and states before and after.

One receipt must cover the public gate, Teaching, confirmed readable input, unconfirmed secure Variable input, learning, a working Dry Run, verification and purge, a later Run, the system alert, Confirmation Allow and Refuse, and Settings refusal followed by Return to Target App and continuation during both Teaching and the later Run. No assertion is relaxed for selected-device preparation.

Attempts 9 and 13 passed earlier implementations. Those receipts do not verify this lifecycle change. Attempts 14 and 15 are the only permitted live attempts for the selected-device revision. Current results and checks are recorded below after execution.

## Limits

The Support Matrix remains unproven. This one-host iOS 26.5 proof cannot establish iOS 27.1, rotation, display replacement, Stop races, x64, signing, notarization, clean-host qualification, or an arbitrary-duration foreground-ownership guarantee. Other-app observation remains a documented SDK limit.

## Selected-device verification results

The selected-device revision passes repository quality and type checks and all 818 CLI unit tests in 105 files. The production CLI and optional framebuffer helper build also pass. Check logs are under `/tmp/ios-selected-sim-checks/`.

Attempt 14 reached fixture setup on iOS 26.5, then stopped before launching Contingency. The proof created simulator `9928EB95-32FE-48D1-8D68-0755D653545F`. The Device panel could not find that exact UDID, including after its prescribed inventory refresh and retry, although simctl listed it. Its error was `No device 9928EB95-32FE-48D1-8D68-0755D653545F on 'This machine' (hostId local). Call device_list for current ids.` The device-tool instructions require stopping after that retry. No direct simulator-driving fallback was used. Attempt 15 was not started because this prerequisite remained unresolved.

The blocker receipt is `.cursor/skills/verify-contingency/artifacts/ios-selected-attempt14/receipt.json`. Setup logs, before/after simulator inventories, process and listener snapshots, and `cleanup-audit.json` are under `/tmp/ios-0067-live/attempt14/`. Cleanup deleted only the exact proof-owned UDID and its fixture directory. All pre-existing simulator identities and states match the baseline. No product server, browser, device session, or private daemon was launched, and the T3 daemon was untouched.

The required complete live receipt remains a gap. Historical successful receipts do not close it. The updated proof retains every earlier journey assertion, adds separate installation approval and existing-data preservation, checks the actual owned framebuffer's selected-device binding, and compares unrelated simulator inventories.
