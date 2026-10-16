# Interface evaluation harness, round 6

2026-10-16. The complete correctness gate passed on both interfaces at `f81cff1e`. The authorized model batches are in progress. Neither adoption gate is established.

## Implementation and conditions

Started at `e749b133` on `feat/461-interface-evaluation`. The session uses `CODEX_HOME=/Users/akshat/.codex-secondary`. No auth contents were read or copied. The production CLI build passed. Both interfaces use that build, private ports, and isolated Catalog Roots. No `packages/` source changed.

Commits:

- `110bbf17` Import Android evaluation preparation
- `206778dd` Record passing browser correctness gate
- `e90945ce` Trim Android emulator identity readback
- `79c1f2e4` Declare unrecorded Android evaluation run
- `cb77bc99` Seed verified Android evaluation package
- `f81cff1e` Close Android evaluation sessions before cleanup

## Correctness gate

| Row | Native | Single-tool | Difference and evidence |
| --- | --- | --- | --- |
| Combined task proof | Pass | Pass | Zero blockers and 113 calls each. [Native](../artifacts/round-6/android/native/task-proof/result.json), [single-tool](../artifacts/round-6/android/single-tool/task-proof/result.json). |
| Session Events phases and wait | Pass | Pass | Supply, Teaching start, instruction, Stop, Verify, Takeover and return, cursor replay, and catalog reread. Native idle wait 45,093 ms; interpreter wait 45,008 ms. [Native phases](../artifacts/round-6/android/native/session-events/result.json), [native wait](../artifacts/round-6/android/native/idle-wait.json), [single-tool phases](../artifacts/round-6/android/single-tool/session-events/result.json). |
| Execution Boundary | Pass | Pass | One dispatched action across concurrent resumes and replay. No later sequence action. [Native](../artifacts/interface-parity/parity-1792137774113-boundary-native/result.json), [single-tool](../artifacts/interface-parity/parity-1792137936079-boundary-single-tool/result.json). |
| Cancellation during an action | Pass | Pass | Both refuse uncertain replay with empty Timeline and exactly one fixture request. [Native](../artifacts/interface-parity/parity-1792137778855-cancellation-native/cancellation.json), [single-tool](../artifacts/interface-parity/parity-1792137941546-cancellation-single-tool/cancellation.json). |
| Deadline after an effect | Not applicable, interpreter-only | Pass | Receipt preserved, process killed, same operation replay adds no item. [Evidence](../artifacts/round-6/android/single-tool/single-tool/05-act-then-deadline.json). |
| Memory limit after an effect | Not applicable, interpreter-only | Pass | `memory_limit`, completed click receipt retained, interpreter exited. [Evidence](../artifacts/round-6/android/single-tool/single-tool/07-act-then-memory-limit.json). |
| `single-tool-proof.mjs browser` | Not applicable | Pass | Separate search, fresh state, uncertainty, Allow and Refuse, concurrent resume, 34,940-byte whole result, cancellation. [Result](../artifacts/round-6/android/single-tool/single-tool/result.json). |
| Android action and intervention | Pass | Pass | Public fill read back, private Variable refused through Workspace and reread. Native used public value 461; single-tool used 460 and also proved no operation after either intervention and whole-read recovery. [Native](../artifacts/interface-parity/parity-1792137832418-android-native/result.json), [single-tool](../artifacts/round-6/android/single-tool/single-tool-android/result.json). |

## Harness defects and fixes

The round-5 rerun allowance applies to model runs, not scripted proofs. Every attempt remains retained. No gate, decision rule, task list, model count, or incorrect-choice rule changed.

1. Round-5 boundary assertion counted all Timeline entries. The committed fix counts dispatched entries and the returned action ID. Both final-revision proofs pass.
2. Round-5 cancellation inspected stderr alone. The committed fix inspects stdout and stderr. Both proofs pass.
3. Round-5 cancellation required a Timeline entry for an uncertain dispatch. The committed fix accepts the explicit refusal with an empty Timeline and still requires exactly one fixture request. Both proofs pass.
4. Round-6 inspection found that the Android model path called `prepareAndroid` without importing it. Added its existing export to the import list in `110bbf17`, before any Android or model run. All browser correctness proofs then ran on that revision.
5. The temporary evidence-copy wrapper used `artifacts/task` instead of `artifacts/task-proof` after the first native combined proof passed. Corrected the copy and retained the original passing proof. A later complete native proof passed on `110bbf17`.

6. The Android prerequisite parser retained the carriage return from adb's CRLF AVD name. Trimmed the first line in `e90945ce`. The [failed native attempt](../artifacts/interface-parity/parity-1792136849246-android-native/result.json) started no session. Later native proofs pass.
7. Inspection found the Android model seed omitted required `recordingId: null`. Added it in `79c1f2e4` before model runs.
8. Inspection found that the model seed requested a later Android Run without creating its verified Android package. Added a disposable package with the documented fixture actions, preparation and outcome in `cb77bc99`. The prompt and final-state check are unchanged.
9. The first Android seed preflight clicked Run Environment Permission even though its preparation recorded no differences or pending requests. Replaced that click with assertions that both lists are empty, then used Prepare selected emulator. [Retained failure](../artifacts/interface-eval/2026-10-16T07-52-54-374Z-android-haiku-native/result.json). No model launched.
10. Seed preflights terminated their process trees with an Android Run still open. The single-tool preflight left its empty device lock, and a later proof correctly refused `helper_owned`. Added explicit Workspace Close and closed-state readback before termination, including failed-seed cleanup, in `f81cff1e`. [Retained refusal](../artifacts/interface-parity/parity-1792137445359-android-native/result.json), [readback](../artifacts/round-6/android/native-cb77/preparation-failure-read.json), and [owned-lock removal](../artifacts/round-6/stale-seed-lock-cleanup.json). The lock creation time matched that preflight; no helper process or adb forward remained. Both corrected seed preflights closed and left no lock, and both final Android proofs passed.

No suspected product defect has been observed. The ownership refusal is documented safety behavior after the evaluator's premature process termination. The temporary copy wrapper also initially selected the browser output directory for an Android proof; its phase-specific copy was corrected and the Android evidence retained.

## Matrix counts and aggregates

The Android model batch has started. Final counts and aggregates are pending. Seed preflights are excluded from model counts.

## Verification and cleanup

The production build, `nub exec turbo run quality`, and `interface-eval/check.mjs` passed. Quality first required formatting the pre-existing round-5 table; the new cleanup code also received the required mechanical lint fixes. Both final correctness stacks were cleaned up and audited with no survivors or listeners. Pixel_9 was booted once after device discovery showed no running emulator. The working checkout fixture and private-text helper were absent before this round and installed by it. The existing adb server and snapshot-helper package are user-owned and remain untouched. Final matrix, emulator and process cleanup are pending. Nothing was pushed and no PR was opened.

## Raw evidence

- [Build log](../artifacts/round-6/build.log), [final source quality](../artifacts/round-6/quality-lifecycle-final.log), and [metric self-check](../artifacts/round-6/check-lifecycle-final.log).
- [Final native cleanup](../artifacts/round-6/android/native/cleanup.json) and [final single-tool cleanup](../artifacts/round-6/android/single-tool/cleanup.json).
- [Final single-tool operation journal](../artifacts/round-6/android/single-tool/all-executions.jsonl).
- [APK build manifest](../artifacts/android-checkout/builds/builds.json), [build cleanup](../artifacts/round-6/android-build/cleanup.json), and [device ownership](../artifacts/round-6/device-ownership.json).
