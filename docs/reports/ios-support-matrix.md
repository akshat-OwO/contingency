# iOS Support Matrix

Issue [#550](https://github.com/akshat-OwO/contingency/issues/550) proves iOS Simulator under [ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md) and [ADR 0067](../adr/0067-runtimes-trade-privacy-and-app-boundaries-for-reach.md). Both matrix cells passed on 2026-10-29 before iOS was listed. Physical devices remain unsupported.

## Cells

Each cell uses the [iOS login fixture](../../.cursor/skills/verify-contingency/fixtures/ios-login/README.md) and the maintained [Workspace proof](../../.cursor/skills/verify-contingency/bin/ios-workspace-proof.mjs). Workspace Teaching records **Login name** as `confirmed` and the secure `{{PASSWORD}}` fill as `unconfirmed`. It activates **Sign in privately**, **Open account**, and the app's **Return to account** navigation button. A Settings activation can also be recorded if input completes before the foreground refusal.

Learning saves the Variable reference without its value. A fresh Dry Run repeats the journey and reports `working`. Workspace **Verify flow** reads back `verified` and `purged`. A later Run repeats the journey and reports `working`.

| Simulator | iOS | Teaching | Dry Run | Verification and Cleanup | Later Run |
| --- | --- | --- | --- | --- | --- |
| iPhone 17 | 26.5 | Pass | `working` | Verified, `purged` | `working` |
| iPhone Duo, outer panel | 27.1 | Pass | `working` | Verified, `purged` | `working` |

Selection accepts iOS 26 through 27. Only 26.5 and 27.1 have proven cells. The [sanitized receipt](ios-support-matrix-evidence.json) follows the Android matrix receipt structure. It records source revisions, fixture source hashes, action kinds, outcomes, limits, and cleanup. It excludes input values, user home paths, and unrelated simulator inventory. Raw local receipts, Timelines, journals, screenshots, and ARIA snapshots remain under `.cursor/skills/verify-contingency/artifacts/ios-support-matrix/`.

## System interaction and limits

Each complete cell receipt includes these checks:

- The public MCP session-list gate refuses iOS before listing.
- The agent answers the notification system alert and remains `running`.
- An irreversible **Open account** action pauses for Confirmation. Workspace Refuse dispatches nothing; Allow dispatches once. Replaying the operation cannot dispatch again, and a retry receives a fresh decision.
- Settings causes `foreign_app_foreground`. **Return to Target App** preserves the signed-in state and selected simulator. Teaching remains recording across recovery, and both Teaching and the later Run continue the account journey.
- The later Run declares `photos` revoked. Workspace shows a permissions difference and Run Environment Permission. After approval and preparation, the first observation reads **Photos access: denied**, without visiting Settings.
- Raw coordinates are rejected by the command schema. Back returns `capability_missing`. Duplicate binding, physical selection (`physical_device_unsupported`), and selections at iOS 25 and 28 (`os_unsupported`) are refused.
- Product activity creates or deletes no simulator. The complete before/after inventory matches, and the selected simulator remains running after sessions close.

## Attempts and fixes

The iOS 26.5 gated attempt 1 passed. Public attempt 2 stopped before Teaching because the proof sent discovery's display-only `state` field as part of an MCP selection. Strict MCP correctly rejected the excess property. The harness now separates discovery metadata from selection fields. Public attempt 3 passed the entire matrix journey with no blockers.

The iOS 27.1 attempt 1 failed during preparation: iPhone Duo exposes two powered integrated panels, which the stream selector refused. A regression test reproduced the failure. The stream now matches a unique integrated screen to the validated Target App screenshot and binds its corresponding framebuffer port. Equal-size panels and unknown dimensions still refuse.

Attempt 2 exposed the SDK's default logical-resolution screenshots. Native-pixel matching alone still refused. A second regression test failed on the 466 by 678 logical capture. The fix uses the integrated screen's declared UI scale and reads orientation from that same screen. The last validated size survives a foreground refusal, which clears the current observation. Attempt 3 passed the entire gated cell. Live folding and rotation were not exercised.

The earlier physical-selection fix decodes a physical iPhone selection so Workspace can return `physical_device_unsupported` before device commands. Its regression tests assert no runtime creation or device action. No agent-device code was changed.

## Listing and public entry

The product no longer reads `CONTINGENCY_IOS_WORKSPACE_INTERNAL` and no longer returns `ios_support_matrix_unproven`. Both CLI entry points install the iOS Workspace service. Workspace shows **iOS**, and public `agent_device_workspace` and `agent_device_sessions_list` accept `platform: "ios"`.

MCP validates selections against the selected platform. Shared JSON Schema references keep the existing catalog budgets intact. Preparation and flow verification remain Workspace-only and are omitted from the agent tool's schema. The live public contract receipt measured 98,439 catalog bytes and 9,747 device-tool bytes. Code execution recognizes iOS preparation and Variable interventions as native device waits.

The final iOS 26.5 attempt repeats the entire matrix journey through public MCP without the gate. Its receipt has no blockers.

The post-listing iOS 27.1 check uses [the shorter public-entry proof](../../.cursor/skills/verify-contingency/bin/ios-public-entry-proof.mjs), because its three full matrix attempts were used. It proves public start, retained listing, semantic public and Variable fills, sign-in, account details, app navigation, close, and simulator retention without the env gate. It does not repeat Teaching, learning, Dry Run, or verification. The complete gated attempt 3 remains that cell's matrix receipt.

## Release artifact check

The macOS build used CI's release implementation: stamp version `0.0.1`, build the CLI, pack with `pack-cli`, and run `verify-cli-install`. npm 12.2.0 matches CI. The scoped install verified CLI version, packed startup, MCP initialization, docs resources, and the single-tool interpreter. The original repository manifest was restored after packaging.

A second npm install used a fresh empty prefix, fresh cache, and isolated HOME with offline strict peer-dependency resolution. The installed ad hoc helper had no quarantine xattr and passed `codesign -v`. On each matrix simulator it emitted three valid sequential JPEG packets for the selected simulator and then exited normally. The temporary prefix, HOME, and npm tooling were removed; the tarball and receipt remain under `/tmp/ios-matrix-release/` for local review.

This is an install on the development Mac. A clean-machine run remains a gap. The framebuffer helper build is explicitly enabled with `CONTINGENCY_BUILD_IOS_FRAMEBUFFER=1`; this check does not qualify an x64 artifact or a different host architecture.

## Cleanup and limits of evidence

Every attempt creates one proof-owned simulator, boots it with `simctl boot <exact UDID>` and `bootstatus -b`, and deletes that exact UDID only after product cleanup. No pre-existing simulator is selected or altered. Completed-attempt audits check the inventory baseline, tracked process identities, listeners, and fixture removal. The follow-up audits also check runner builds outside caches. Product sessions leave the selection running before fixture teardown.

All matrix-owned product processes and listeners exited. No installed fixture or new runner build remains. The two T3-owned listeners created by opening the Device panel were preserved; the panel was closed without signaling its daemon or hub. An unrelated October 27 temporary directory containing only a daemon log was preserved. The isolated verification state was purged. Raw retained state and media are local evidence, not part of these sanitized reports.

Process ownership was reconstructed from launch and end snapshots, instance records, descendant readbacks, and exact-UDID markers. Short-lived children between snapshots are not exhaustively recorded. Cleanup checks establish that no tracked child or matching runtime remained alive.

Live folding, rotation, display replacement, Stop races, x64, and an arbitrary-duration foreground-ownership guarantee remain outside this proof. The clean-machine install remains open. These limits do not change the two proven journey cells.

## Required checks

Quality and type checks passed. The CLI unit suite passed 835 tests in 106 files. The production CLI and framebuffer build passed. The integration suite ran once, alone, from `packages/cli` and passed 178 tests in 43 files. Product source did not change after the release build or public proofs.

The final cleanup audit passed after integration. Simulator inventory and TCP listeners match the baseline, and no owned test or proof process remains. Local logs and audits are under `/tmp/ios-matrix-*`; the resource ledger is `/tmp/ios-matrix-resource-ledger.md`.
