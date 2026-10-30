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

This earlier check installed a locally built helper on the development Mac. It did not prove the Ubuntu release workflow included that helper. A clean-machine run remains a gap, and native x86_64 execution has not been qualified.

## Packaging

Release and PR artifact CI now build a universal arm64 + x86_64 framebuffer helper on one GitHub-hosted macOS runner. The job verifies both architectures with `lipo` and the ad hoc signature with `codesign`. The Ubuntu job restores the binary and manifest after the CLI build, requires them before packing, and checks them again in the fresh npm install. Published installs require no local build environment variable or helper compilation. Local Linux source builds may still omit it.

The versioned manifest pins the exact packaged binary SHA-256, since Xcode versions do not produce identical bytes. Runtime checks that digest and both actual Mach-O executable slices. The manifest detects corruption or replacement of the binary alone; it is not an independent publisher identity. npm provenance supplies package origin evidence. Ad hoc signing does not establish Developer ID identity or notarization.

A locally packed universal tarball was installed with npm into a fresh, empty prefix with an isolated HOME. The installed helper reported `x86_64 arm64` from `lipo`, passed `codesign -v --strict --all-architectures`, and had no quarantine attribute. On a proof-owned iOS 26.5 simulator, it streamed five sequential packets from the integrated display at 720×1566 after `start`, then stopped and exited 0. The simulator was deleted by exact UDID. Only CI can prove the macOS-runner build and the artifact transfer to Ubuntu.

## Cleanup and limits of evidence

Every attempt creates one proof-owned simulator, boots it with `simctl boot <exact UDID>` and `bootstatus -b`, and deletes that exact UDID only after product cleanup. No pre-existing simulator is selected or altered. Completed-attempt audits check the inventory baseline, tracked process identities, listeners, and fixture removal. The follow-up audits also check runner builds outside caches. Product sessions leave the selection running before fixture teardown.

All matrix-owned product processes and listeners exited. No installed fixture or new runner build remains. The two T3-owned listeners created by opening the Device panel were preserved; the panel was closed without signaling its daemon or hub. An unrelated October 27 temporary directory containing only a daemon log was preserved. The isolated verification state was purged. Raw retained state and media are local evidence, not part of these sanitized reports.

Process ownership was reconstructed from launch and end snapshots, instance records, descendant readbacks, and exact-UDID markers. Short-lived children between snapshots are not exhaustively recorded. Cleanup checks establish that no tracked child or matching runtime remained alive.

Live folding, rotation, integrated-port UUID replacement and recovered-journey continuation, x64, and an arbitrary-duration foreground-ownership guarantee remain outside this proof. The clean-machine install remains open. These limits do not change the two proven journey cells.

## Display changes and Stop follow-up

The focused [display proof](../../.cursor/skills/verify-contingency/bin/ios-display-changes-proof.mjs) uses Workspace controls, public device MCP, a second Workspace input client, and one new fixture simulator per attempt. Stop attempt 3 passed both races on iOS 26.5. The browser click completed while the backend fill was in flight, then in a separate session while a post-fill screenshot was settling. Each recording contains exactly one fill and a final `stopped` event. Five later mirror packets leave its retained interval and event stream unchanged. The learning-agent Timeline returns exactly one semantic fill. No extra backend input was dispatched. This live Stop receipt predates the later recovery-only worker guards; the final unit suite covers stream integrity and those guards, but the three-attempt cap prevents another live Stop run. Stop drains the already accepted action before finalizing; it does not undo dispatched input.

Stop attempt 1 is superseded: its filesystem watcher waited for another journal event after finding the stage. Attempt 2 passed the in-flight case but selected brief session-list metadata as settling capture. The final watcher returns immediately and selects an actual screenshot request. Deterministic regressions failed on both old behaviors. The timing assertions now compare browser click completion with backend completion. Raw final evidence is `artifacts/ios-display/stop3/` under the verification skill, including the receipt, backend requests, Timeline readbacks, screenshots, and ARIA snapshots.

Rotation attempt 1 stopped before Teaching with `DEVICE_IN_USE` because a separate Device panel session claimed the simulator before product preparation. The 2026-10-30 continuation task requested orientation and folding through the product's existing SDK session. This execution environment still requires device-panel tools for device controls, while the task forbids that route. No additional rotation or folding attempt was made. Both remain live-proof gaps, including rotation during Teaching and Run and iPhone Duo fold and unfold on iOS 27.1. The installed agent-device 0.21.25 types confirm `client.command.orientation({ orientation, ...identifiers })` and `client.command.fold({ pose, ...identifiers })`. API availability does not prove either journey.

The host exposes display power and geometry changes, but no supported integrated-port UUID replacement operation was found. UUID replacement and live rebind remain unproven and were not attempted. The unavailable-display proof powers the selected integrated port off and back on by exact UUID. The UUID remained unchanged in every current attempt.

Earlier display attempts 1 through 3 exposed and regressed the missing structured refusal and two worker-lifecycle races. Workspace now returns `{ code: "capture_incomplete", recovery: "recover" }`, keeps **Recover selected simulator**, and preserves the failed recording after recovery. Retired helper callbacks and old display enumerations cannot fault a replacement worker. Those fixes did not establish recovered-journey continuation. Callback diagnostics were moved to stderr after the earlier attempt 3.

The 2026-10-30 continuation used its three newly authorized attempts. Evidence is under `.cursor/skills/verify-contingency/artifacts/ios-display-finish/recovery1/` through `recovery3/`; process, memory, production-build, and cleanup records are under `/tmp/ios-display-finish/`. Recovery1 reproduced the next-pick failure. Recovery2 added bounded helper diagnostics and identified the direct failure: the new helper exits with code 1 and `Selected display lost its framebuffer` when sampling after the mirrored **Open account** pick. The same message names the initial powered-off-display failure. No UUID change, stale-worker callback, or viewer overflow was logged as the cause of this second failure. This identifies the failed helper check, but does not explain why CoreSimulator returns a null framebuffer after recovery.

Recovery3 tested an experimental change that omitted samples while the framebuffer was null. A native fixture first reproduced the old immediate exit, then passed when a replacement surface became available. Live continuation still failed the unchanged **Account details** assertion. The helper stayed alive and the session remained running, but the captured mirror was black. That experiment did not establish a transient surface handoff as the live cause. Its behavior change and native fixture were reverted. The final source keeps the diagnostics and explicit refusal behavior. Continued navigation after recovery remains unresolved; no passing display receipt exists, and no fourth current attempt was run.

The final diagnostic reports the helper's exit code, signal, and only allowlisted static helper messages on stderr. Packet validation and display-monitor failures now name their own reasons instead of appearing as helper exits. Integrity diagnostics retain the current generation's reason even after an earlier recording has failed. No pixels, inputs, or arbitrary subprocess stderr enter these diagnostics.

Final continuation checks pass on the restored source: the production CLI and universal framebuffer build, repository quality, and all four package type checks. The CLI unit suite passed 847 tests in 108 files; both affected UI tests passed. Integration ran once, alone, from `packages/cli` and passed 178 tests in 43 files. The three current live-attempt cleanup audits and the integration cleanup audit pass. No tracked process, owned listener, private product directory, or integration suite root remains. All three current proof simulators were deleted by exact UDID, and simulator inventory matches the starting snapshot. The resource ledger and check logs are under `/tmp/ios-display-finish/`. No proof route changed, so the verification feature recipe is unchanged.

## Original matrix checks

Quality and type checks passed. The CLI unit suite passed 835 tests in 106 files. The production CLI and framebuffer build passed. The integration suite ran once, alone, from `packages/cli` and passed 178 tests in 43 files. Product source did not change after the release build or public proofs.

The final cleanup audit passed after integration. Simulator inventory and TCP listeners match the baseline, and no owned test or proof process remains. Local logs and audits are under `/tmp/ios-matrix-*`; the resource ledger is `/tmp/ios-matrix-resource-ledger.md`.
