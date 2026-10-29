# Android Support Matrix

Issue [#567](https://github.com/akshat-OwO/contingency/issues/567) re-proves Android under [ADR 0067](../adr/0067-runtimes-trade-privacy-and-app-boundaries-for-reach.md). Both cells passed live on 2026-10-29 against product revision `45d156c4`. The matrix covers the two emulator images below. Physical devices are unsupported.

## Cells

Each cell runs [`android-support-matrix-proof.mjs`](../../.cursor/skills/verify-contingency/bin/android-support-matrix-proof.mjs) against the [login fixture](../../.cursor/skills/verify-contingency/fixtures/android-physical/README.md), with minimum API 30. Workspace Teaching records a public **Login name** fill, a `{{PASSWORD}}` Variable fill, **Sign in privately**, **Open account**, and **Android Back**. The Timeline contains one `fill`, one `variable`, two `activate`, and one `back` action. Variable values use stock agent-device as ordinary text and appear in runtime evidence. A fill records `confirmed` when readable text matches, or `unconfirmed` when exact readback is unavailable. Sign-in establishes the journey outcome.

An agent learns the Flow Skill and repeats every action through MCP in a fresh Dry Run. The user chooses **Verify flow** in Workspace, Cleanup purges the Recording and Dry Run evidence, and a later Run repeats the journey.

| Emulator | API | Android | Teaching | Dry Run | Verification and Cleanup | Later Run |
| --- | --- | --- | --- | --- | --- | --- |
| Pixel_9 | 36 | 16 | Pass | `working` | Verified, `purged` | `working` |
| Pixel_9_API_30 | 30 | 11 | Pass | `working` | Verified, `purged` | `working` |

The [sanitized evidence](android-support-matrix-evidence.json) records device identities, source revision, fixture hash, action kinds, outcomes, boundary probes, and cleanup. Generated Variable values and credentials are excluded from retained evidence. ARIA snapshots, screenshots, sanitized Timelines, command journals, and receipts remain under `.cursor/skills/verify-contingency/artifacts/android-support-matrix/<cell>/`.

Selection accepts API 30 through 36. Only API 30 and 36 have proven cells. Intermediate levels are accepted without separate proof.

## Full OS use and Confirmation

Each cell exercises untaught controls on a later live Run:

- **Request camera permission** opens the system dialog. The agent answers through MCP, and the fixture regains focus while the Run remains `running`, without `ownership_unknown`.
- **Open device settings** opens Settings while the Run remains `running`. Runtime Back returns to the fixture.
- Marking **Open device settings** `irreversible:true` creates a Pending Decision with reason `confirmation`. The session remains `running` while input waits for the decision. Workspace shows `Activate button "Open device settings" in dev.contingency.physicalfixture` with enabled **Allow** and **Refuse** controls.
- Three separate attempts exercise Allow, Refuse, and Allow. Allow dispatches the stored attempt to Settings. Refuse leaves the fixture visible. Every retry receives a distinct Confirmation ID.

## Documented limits

| Limit | Proven behavior in each cell |
| --- | --- |
| Physical devices | A synthetic non-emulator selection is refused as unsupported before any child command uses its serial. |
| API levels below 30 | API 29 selection is refused before Teaching. |
| Multiple bound devices | A second live session is refused on both the same serial and another emulator serial. |
| Raw coordinates | MCP rejects `tap`. A blank Workspace point shows **Nothing to activate there. No input was sent.** |
| Secure windows | A `FLAG_SECURE` window pauses on `secure_window` with **Secure window, not visible**. A `working` claim is stored as `inconclusive`. |

Android 11 lacks `pm set-permission-flags`. Preparation permission decisions require API 31 and are refused on API 30 with `permission_decisions_unsupported`. Answering a live system dialog through the agent remains supported on both proven cells.

## Proof and cleanup

The limits Run takes Workspace control for the blank-point probe and returns it before agent actions. It records Takeover and ends `inconclusive` after the secure-window probe. This outcome is separate from the successful journey Run.

On API 36, the pending-Confirmation screenshots show **Device stream lost** while the decision controls and description remain visible. Fresh MCP observations confirm that the fixture stays visible before a decision, Allow opens Settings, and Refuse leaves the fixture visible. These screenshots prove the decision UI, with MCP readback proving the OS transitions.

The proof restores installed-package, input-method, forwarding, and runtime-directory baselines. It stops its MCP server, isolated Workspace, driver browser, and emulator. The parent-owned ADB server remains running. Raw Teaching and Run state is purged with the isolated verification directory.

Secure-window capture, concurrent device Runs, and additional emulator images remain outside this proof.
