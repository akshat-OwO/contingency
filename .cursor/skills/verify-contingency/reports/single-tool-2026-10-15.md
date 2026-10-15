# Single-tool interface proof, 2026-10-15

The experimental single-tool interface (ADR 0059, #460) passed the [single-tool recipe](../features/workspace.md#single-tool-interface) on the final revision. The combined task proof ran entirely through `agent_code_execute` with no blockers, the focused browser proof passed, and the Android proof passed on the Pixel_9 API 36 emulator. One correctness defect was found and fixed in the same change; the remaining findings are recorded below for the comparative evaluation.

All drives used the production CLI, real Chromium, the isolated ecommerce site, Workspace controls, and `CONTINGENCY_MCP_INTERFACE=single-tool`. `mcp tools` listed only `agent_code_execute`.

| Path | Observed result | Evidence under `artifacts/` |
| --- | --- | --- |
| Combined task proof through programs | `status: passed`, 0 blockers. 113 executions over 21 operations: 104 completed, 5 ended at Confirmations or Domain Scope boundaries, 3 at Variable requests, and 1 at setup handoff. Receipts: 110 succeeded and 3 failed, all of them expected refusals. No value was truncated, and neither secret literal appears in the journal. This covers Workspace Teaching, Flow Skill learning, Dry Runs, Verify and Reject, Interactive Runs, scoped secret Variables, Confirmation, Takeover, user closure, process exit, Cleanup resumption, and restart. | `task-proof/result.json`, `task-proof/single-tool.jsonl`, numbered responses, ARIA, screenshots |
| Separate search | Search ran in its own execution with no receipts. It lists Android and browser operations and omits `agent_code_run`. | `single-tool/01-search.json` |
| Fresh state, persistent Run | The next program cannot see the earlier program's variable and runs in a new process. The Run persists. | `single-tool/02-*`, `03-*` |
| Session Event wait | `agent_session_get` with `waitMs: 45000` took 45,008 ms, measured inside the program. | `single-tool/04-session-event-wait.json` |
| Timeout after an effect | `deadline_exceeded` with SIGKILL, a `succeeded` click receipt, and the process gone. Retrying the same `operationId` returned one attempt and `1 item in cart`. | `single-tool/05-*`, `06-*` |
| Process failure after an effect | The program ended `memory_limit` with its click receipt kept. | `single-tool/07-*` |
| Interrupted dispatch | A program stopped during a 30-second wait recorded an `uncertain` receipt. | `single-tool/08-*` |
| Confirmation, Refuse | The program ended at `boundary` and `pending_decision`; the second click has no receipt. After Workspace `Refuse`, the history shows `refuse` from `workspace`, resume is refused, and the cart is unchanged. | `single-tool/09-*`, `10-*`, `confirmation-paused.*` |
| Confirmation, Allow, concurrent resume | After Workspace `Allow`, two concurrent programs returned the same attempt id, and the cart went from 2 to 3. | `single-tool/11-*` to `14-*`, `confirmation-allowed.*` |
| Android action | A program filled `Shopper name` and read `460` back from a fresh observation. | `single-tool-android/02-android-action.json` |
| Android interventions | The start ended at `device_preparation` before the next `observe` was dispatched. A `SETUP_PASSWORD` request ended its program at `variable_requested` with the same guarantee. After Workspace `Refuse SETUP_PASSWORD`, the reread shows `refused`. | `single-tool-android/01-*`, `03-*`, `04-*`, `android-*.png` |

## Correctness findings

- **Fixed: undeclared failures leaked server internals.** A handler failure that was neither an `AiError` nor the tool's declared failure reached programs and receipts as `Cause.pretty` output, which included a stack with local paths. Native MCP logs that failure and answers `Tool execution failed due to an internal server error.`, and it answers a declared failure with its message. The interpreter now does the same. `mcp-code-interpreter.test.ts` compares both interfaces on one refusal; it failed before the fix.
- **Open: whole results over 16 KB are truncated.** A full Android `read` returned `truncated: true` with a string value, while the status still said `completed`. Native tools return the whole result. Programs must project the fields they need. An agent that returns a whole result receives a partial string rather than a refusal.
- **Open: client cancellation was not driven end to end.** Deadlines, memory exhaustion, and interrupted waits were proven live. An MCP `notifications/cancelled` request arriving during a program was not, because the verification broker cannot send one.
- **Not a defect: the interpreter is restricted JavaScript.** `globalThis` is an unknown identifier. Programs use local bindings.

## Validation

The final revision passed `nub exec turbo run quality`, `nub exec turbo run check-types --filter=@contingencyhq/cli`, and a forced production CLI build. From `packages/cli`, `nub exec vitest run tests/routes/mcp-code-interpreter.test.ts tests/services/code-interpreter.test.ts` passed all 21 tests. The changed route file passed five consecutive runs.

The live commands were `nub .cursor/skills/verify-contingency/bin/task-proof.mjs`, `nub .cursor/skills/verify-contingency/bin/single-tool-proof.mjs`, and the latter with `android`. Export `CONTINGENCY_MCP_INTERFACE=single-tool` for the entire drive. Setting it only on the initial `mcp start` lets the combined proof's restart return to native mode. The final combined proof retained 113 single-tool executions, including calls after restart.

## Adapter

`control-contingency mcp call` translates each native call into a one-operation program when MCP runs single-tool, so existing recipes run unchanged. It never forwards a native call. Programs that combine operations, and that prove later actions are never dispatched, are in `bin/single-tool-proof.mjs`.

The Android proof installed the checkout fixture and Contingency's private text helper on an emulator it booted. Both were uninstalled afterward, leaving the preexisting snapshot helper, and the emulator was shut down. The final rerun used T3's Device panel; its shared device host and ADB service remain app-managed. Cleanup stopped every owned process; no `code-interpreter-process` remained. Raw video, Traces, and Teaching recordings were not copied into artifacts.
