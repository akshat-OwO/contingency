# Interface evaluation harness, round 5

2026-10-16. Blocked during the native correctness gate. The native combined task proof passed with no blockers. The new boundary proof passed after one retained harness failure. The new cancellation proof used its one rerun and hit a second harness assertion defect. Both cancellation attempts reached the fixture, cancelled the in-flight call, and refused an identity replay as uncertain without redispatch. The corrected final script has not run. No Android, Sol, or Haiku matrix runs started. Neither adoption gate is established.

## Implementation and conditions

Started at `b17b31b9` on `feat/461-interface-evaluation`. Changes are limited to verification scripts and documentation. No `packages/` source changed. The production build used `nub exec turbo run build --filter=@contingencyhq/cli --force` and passed. The isolated launch passed `doctor`, then served ecommerce and native MCP on private ports. The combined proof restarted its owned MCP process as part of its existing restart checks.

The active implementation session has `CODEX_HOME=/Users/akshat/.codex-secondary`. The Sol driver now symlinks `INTERFACE_EVAL_CODEX_AUTH`, defaulting to `~/.codex-secondary/auth.json`, into its isolated home. It records the source path in driver metadata. No auth contents were read, printed, or copied. No model process ran, so this round does not verify authentication through a Sol driver launch.

`bin/interface-parity-proof.mjs <boundary|cancellation|android>` uses native-shaped `control-contingency mcp call` commands. The existing broker adapter turns those commands into one-operation programs under single-tool. Each proof attempt gets a unique evidence directory and records command responses, memory, owned processes, ports, and cleanup.

The boundary phase stops a sequence at its first irreversible action, checks zero cart effects, allows that stored attempt in Workspace, races two resumes, replays again, and checks the same action ID and one dispatched action. The cancellation phase holds an HTTP navigation response, waits on the incoming request, cancels through `mcp cancel`, releases the response, and retries the identical operation ID. Its assertion accepts a recorded attempt or the explicit uncertain-dispatch refusal and requires one fixture request. Deadline and memory-limit proofs remain interpreter-only and are not applicable to native.

The Android phase is implemented but unverified. It uses attached-device declarations, prepares the selected emulator through Workspace, fills a public field and reads it back, requests a private Variable, refuses it through Workspace, rereads refusal, and closes the session. It never boots a device or installs the fixture itself.

Commits:

- `663a925` Add matched native correctness proofs
- `bcab712` Count dispatched attempts in parity proof
- `6ad65577` Check uncertain cancellation replay evidence

## Correctness gate

The final harness revision is `6ad65577`. No complete correctness gate ran on that revision. Earlier passes below remain useful retained evidence, but do not satisfy the requested final-revision gate.

| Row | Native | Single-tool | Difference and evidence |
| --- | --- | --- | --- |
| Combined task proof | Pass at `663a925`; final revision pending | Not run | Zero blockers, 113 MCP calls. [Retained result](../artifacts/round-5/native/task-proof/result.json). |
| Session Events phases and wait | Not run | Not run | Stopped before this row. |
| Execution Boundary | Initial harness failure, then pass at `bcab712`; final revision pending | Not run | Concurrent resumes and replay returned the same ID; one dispatched action. [Passing result](../artifacts/interface-parity/parity-1792135771010-boundary-native/result.json), [resume readback](../artifacts/interface-parity/parity-1792135771010-boundary-native/resumed.json). |
| Cancellation during an action | Two retained harness failures; final correction unverified | Not run | Both native calls were cancelled. Both retries refused an uncertain dispatch. The second attempt observed exactly one fixture request before the invalid Timeline assertion. [Second result](../artifacts/interface-parity/parity-1792135799675-cancellation-native/result.json), [command evidence](../artifacts/interface-parity/parity-1792135799675-cancellation-native/commands.json). No cross-interface comparison yet. |
| Deadline after an effect | Not applicable, interpreter-only | Not run | No interpreter-limit proof ran. |
| Memory limit after an effect | Not applicable, interpreter-only | Not run | No interpreter-limit proof ran. |
| `single-tool-proof.mjs browser` | Not run | Not run | No full script run on either interface. |
| Android action and intervention | Not run | Not run | Device work never started. |

## Harness defects and stop reason

Every attempt is retained. These are proof defects, not established product defects.

1. Boundary attempt `parity-1792135752638-boundary-native` expected one total Timeline entry after approval. The Timeline also records the undispatched boundary and the user's approval. Fix: count dispatched entries and occurrences of the returned action ID. [Original result](../artifacts/interface-parity/parity-1792135752638-boundary-native/result.json) is annotated `harnessDefect:true`. Its one rerun passed.
2. Cancellation attempt `parity-1792135781722-cancellation-native` inspected stderr for the uncertain refusal, while `control-contingency` printed it on stdout. Fix: inspect both streams. [Original result](../artifacts/interface-parity/parity-1792135781722-cancellation-native/result.json) is annotated `harnessDefect:true`.
3. Cancellation rerun `parity-1792135799675-cancellation-native` required one Timeline entry even when the operation ledger returned an uncertain-dispatch refusal. The session Timeline was empty. Fix: accept that explicit uncertainty, while still asserting no second fixture request. [Rerun result](../artifacts/interface-parity/parity-1792135799675-cancellation-native/result.json) is annotated `harnessDefect:true`.

The user's instruction permits a harness-defect rerun of a cell once. Cancellation already used that rerun. I stopped before a third attempt and before later work. The final assertion correction is committed, but remains unverified. Continuing needs the parent to resolve this exhausted rerun allowance. No gate, decision rule, task list, model run count, or incorrect-choice rule changed. No plan amendment was added.

## Matrix counts and aggregates

All counts below are model processes started in this round. Each cell is zero; none failed or completed because none launched. Prior-round runs remain untouched and are not counted as round-5 runs.

| Task     | Haiku native | Haiku single-tool | Sol native | Sol single-tool |
| -------- | -----------: | ----------------: | ---------: | --------------: |
| cart     |            0 |                 0 |          0 |               0 |
| checkout |            0 |                 0 |          0 |               0 |
| refuse   |            0 |                 0 |          0 |               0 |
| learn    |            0 |                 0 |          0 |               0 |
| dry-run  |            0 |                 0 |          0 |               0 |
| takeover |            0 |                 0 |          0 |               0 |
| android  |            0 |                 0 |          0 |               0 |

For every cell, median and minimum–maximum input, peak, output tokens, and wall time are unavailable. R1–R4 totals are unmeasured, and completion is 0/0, not 0%. There are no new measurements to aggregate. Remaining authorized matrix work is 12 Android runs, 36 Sol browser runs, and the first 12 Haiku browser runs, after correctness and the rerun blocker are resolved. The remaining 24 Haiku browser runs still require the parent's usage check.

## Verification and cleanup

The production build, `nub exec turbo run quality`, direct Oxlint/Oxfmt checks on the hidden scripts, and `nub .cursor/skills/verify-contingency/bin/interface-eval/check.mjs` passed. The final quality run reported zero errors and warnings. The final diff was reviewed. The auth-source change and Android phase have no live driver/device evidence yet.

Memory snapshots before the native task proof and each parity attempt showed zero swap and more than 3 GB free plus inactive. No emulator was booted, device host opened, fixture installed, or model launched. No auth symlink was created by a driver.

`control-contingency cleanup` completed. A pre-cleanup process-tree snapshot tracked 28 live owned processes. The independent post-cleanup audit found zero surviving matching PIDs and zero listeners on all seven current and original instance ports. Each of the four parity attempt cleanup manifests also reports zero survivors and zero listeners, including the two held-navigation HTTP ports. Build and quality sessions exited with status zero; proof sessions exited with the recorded status. Evidence survives cleanup. No user-owned process or port-7782 host MCP process was signaled. Nothing was pushed and no PR was opened.

## Raw evidence

- [Build log](../artifacts/round-5/build.log), [final quality log](../artifacts/round-5/quality.log), and [native task memory](../artifacts/round-5/task-native-memory.log).
- [Native combined proof](../artifacts/round-5/native/task-proof/result.json), with its complete copied command and readback evidence.
- [Boundary original](../artifacts/interface-parity/parity-1792135752638-boundary-native/result.json) and [boundary rerun](../artifacts/interface-parity/parity-1792135771010-boundary-native/result.json).
- [Cancellation original](../artifacts/interface-parity/parity-1792135781722-cancellation-native/result.json) and [cancellation rerun](../artifacts/interface-parity/parity-1792135799675-cancellation-native/result.json). Their sibling `commands.json` files retain stdout, stderr, and exit status.
- [Cleanup audit](../artifacts/round-5/cleanup-audit.json), [owned process tree](../artifacts/round-5/processes-before-cleanup.json), and [instance ownership](../artifacts/round-5/instance-before-cleanup.json).
