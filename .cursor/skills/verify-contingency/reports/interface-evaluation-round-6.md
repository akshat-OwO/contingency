# Interface evaluation harness, round 6

2026-10-16. Browser correctness passed on both interfaces at `110bbf17`. Android correctness and the authorized model batches are pending. Neither adoption gate is established.

## Implementation and conditions

Started at `e749b133` on `feat/461-interface-evaluation`. The session uses `CODEX_HOME=/Users/akshat/.codex-secondary`. No auth contents were read or copied. The production CLI build passed. Both interfaces use that build, private ports, and isolated Catalog Roots. No `packages/` source changed.

Commits:

- `110bbf17` Import Android evaluation preparation

## Correctness gate

| Row | Native | Single-tool | Difference and evidence |
| --- | --- | --- | --- |
| Combined task proof | Pass | Pass | Zero blockers and 113 calls each. [Native](../artifacts/round-6/native/task-proof/result.json), [single-tool](../artifacts/round-6/single-tool/task-proof/result.json). |
| Session Events phases and wait | Pass | Pass | Supply, Teaching start, instruction, Stop, Verify, Takeover and return, cursor replay, and catalog reread. Native idle wait 45,059 ms; interpreter wait 45,008 ms. [Native phases](../artifacts/round-6/native/session-events/result.json), [native wait](../artifacts/round-6/native/idle-wait.json), [single-tool phases](../artifacts/round-6/single-tool/session-events/result.json). |
| Execution Boundary | Pass | Pass | One dispatched action across concurrent resumes and replay. No later sequence action. [Native](../artifacts/interface-parity/parity-1792136321431-boundary-native/result.json), [single-tool](../artifacts/interface-parity/parity-1792136477784-boundary-single-tool/result.json). |
| Cancellation during an action | Pass | Pass | Both refuse uncertain replay with empty Timeline and exactly one fixture request. [Native](../artifacts/interface-parity/parity-1792136326109-cancellation-native/cancellation.json), [single-tool](../artifacts/interface-parity/parity-1792136483192-cancellation-single-tool/cancellation.json). |
| Deadline after an effect | Not applicable, interpreter-only | Pass | Receipt preserved, process killed, same operation replay adds no item. [Evidence](../artifacts/round-6/single-tool/single-tool/05-act-then-deadline.json). |
| Memory limit after an effect | Not applicable, interpreter-only | Pass | `memory_limit`, completed click receipt retained, interpreter exited. [Evidence](../artifacts/round-6/single-tool/single-tool/07-act-then-memory-limit.json). |
| `single-tool-proof.mjs browser` | Not applicable | Pass | Separate search, fresh state, uncertainty, Allow and Refuse, concurrent resume, 34,940-byte whole result, cancellation. [Result](../artifacts/round-6/single-tool/single-tool/result.json). |
| Android action and intervention | Pending | Pending | Step 2 has not started. |

## Harness defects and fixes

The round-5 rerun allowance applies to model runs, not scripted proofs. Every attempt remains retained. No gate, decision rule, task list, model count, or incorrect-choice rule changed.

1. Round-5 boundary assertion counted all Timeline entries. The committed fix counts dispatched entries and the returned action ID. Both final-revision proofs pass.
2. Round-5 cancellation inspected stderr alone. The committed fix inspects stdout and stderr. Both proofs pass.
3. Round-5 cancellation required a Timeline entry for an uncertain dispatch. The committed fix accepts the explicit refusal with an empty Timeline and still requires exactly one fixture request. Both proofs pass.
4. Round-6 inspection found that the Android model path called `prepareAndroid` without importing it. Added its existing export to the import list in `110bbf17`, before any Android or model run. All browser correctness proofs then ran on that revision.
5. The temporary evidence-copy wrapper used `artifacts/task` instead of `artifacts/task-proof` after the first native combined proof passed. Corrected the copy and retained the original passing proof. A later complete native proof passed on `110bbf17`.

No suspected product defect has been observed.

## Matrix counts and aggregates

No model processes have started in round 6. All 28 task, interface, and primary-model cells have zero runs. Input, peak, and output token medians and ranges, R1–R4 totals, and wall times are unmeasured. Completion is 0/0, not 0%.

## Verification and cleanup

The production build and `interface-eval/check.mjs` passed. `nub exec turbo run quality` passed after `quality:fix` corrected the pre-existing round-5 table formatting. Final quality checks remain due after later steps. Native cleanup audited 440 recorded processes and nine ports with no surviving matching process or listener. Single-tool cleanup audited 413 recorded processes and five current ports with no survivors or listeners. The original MCP ports also require the final independent audit. No emulator has been booted or fixture installed. Nothing was pushed and no PR was opened.

## Raw evidence

- [Build log](../artifacts/round-6/build.log) and [metric self-check](../artifacts/round-6/check.log).
- [Native cleanup](../artifacts/round-6/native/cleanup.json).
- [Single-tool operation journal](../artifacts/round-6/single-tool/all-executions.jsonl).
