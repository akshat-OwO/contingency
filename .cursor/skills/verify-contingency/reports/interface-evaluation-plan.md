# Native versus single-tool evaluation plan (#461)

Recorded 2026-10-16, before any comparative result was collected. ADR 0059 makes the single-tool interface the default only if both gates pass:

1. **Correctness.** It completes the representative journeys the native tools support, with no observed regression in action correctness or recovery.
2. **Benefit.** It measurably reduces model context usage or incorrect operation choices.

The two gates are measured separately. Scripted proofs establish the first, because they control every step and can assert exactly what was dispatched. Model-driven runs establish the second, because only a model reveals what context it spends and which operations it chooses.

## Fixed conditions

Every run records these values, and the report states them once:

- **Commit.** The tested commit of `eval/458-single-tool-code-mode`, built once with `nub exec turbo run build --filter=@contingencyhq/cli --force`. Both interfaces run the same build; only `CONTINGENCY_MCP_INTERFACE` differs.
- **Runtime.** Node, the pinned OpenCode codemode package, Effect 4.0.1, Chromium from `playwright-core`.
- **Environment.** This Mac (macOS, 24 GB), the isolated ecommerce fixture, a fresh Catalog Root per run, and the Pixel_9 API 36 emulator for Android.
- **Models.** Two drivers, so a result is not one model's quirk:
  - `claude-haiku-5-5` through `claude -p`, default effort.
  - `gpt-6.1-sol` at `medium` reasoning through `codex exec`.
  Each records its CLI version.
- **Client context.** Each driver sees only the Contingency MCP server: no other MCP servers, no user or project instructions, no repository checkout as its working directory. The prompt text is identical across interfaces. Unavoidable differences, such as each CLI's own system prompt and built-in tools, are the same within a model and are recorded.

## Correctness gate: scripted parity

Run each proof once per interface on the tested commit:

| Proof | Native | Single-tool |
| --- | --- | --- |
| Combined task proof (`task-proof.mjs`): Teaching, Flow Skill learning, Dry Run, Verify and Reject, Interactive Run, secret Variables, Confirmation, Takeover, user closure, process exit, Cleanup resumption, restart | as is | `CONTINGENCY_MCP_INTERFACE=single-tool` for the whole drive |
| Session Events recipe, including the ~45 s wait | as is | same |
| Execution Boundary recipe: intervention dispatches nothing later, stored attempts resume at most once | as is | same, plus `single-tool-proof.mjs` |
| Cancellation, deadline, and process failure after an effect | native cancellation of an in-flight tool call | `single-tool-proof.mjs` |
| Android: one action and one intervention | `android-checkout-proof.mjs` | `single-tool-proof.mjs android` |

The gate passes when every proof passes on both sides and no single-tool run shows a dispatched action, receipt, or recovery outcome that the native run does not. A blocker on either side is reported, not retried until green.

## Benefit gate: model-driven matched tasks

Each task starts from the same seeded state, with the same prompt, and ends with a scripted check of the final state. Where a task needs the user, a scripted user acts through the Workspace exactly as the recipes do, and only after the model has asked for it.

| Id | Task | Scripted user | Final-state check |
| --- | --- | --- | --- |
| `cart` | Add two named products to the cart and report the total | none | cart contents and the reported total |
| `checkout` | Check out with a secret Variable | supplies the Variable privately, then allows the purchase Confirmation | order placed once; the secret literal is absent from every model-visible message |
| `refuse` | Same checkout, but the user refuses the Confirmation | refuses | no order; the model reports the refusal and dispatches nothing after it |
| `learn` | Learn and save a Flow Skill from a seeded Teaching Recording | none | saved Flow Skill passes the contract and is parameterized |
| `dry-run` | Dry Run a seeded Flow Skill with changed inputs and report the result | verifies the flow | Dry Run Summary is complete and verified |
| `takeover` | Interactive Run where the user takes over midway and changes the cart | takes over, edits, hands back | the model rereads before acting and the cart matches the user's change plus the remaining task |
| `android` | Fill and submit the Android checkout fixture | none | the submitted values on the device |

**Run count.** Three runs per task, interface, and model: 7 × 2 × 2 × 3 = 84 runs. Three runs is the smallest count that shows run-to-run spread on every cell, and the machine runs only one browser-and-model stack at a time. If a gate's outcome changes with one run either way, that cell gets two more runs on both interfaces, and the report says so. Every run is kept, including failures; none is rerun to replace a bad result.

**Order.** Runs interleave native and single-tool for each task and model, so drift over the session (rate limits, caching, machine load) affects both sides alike.

## Measurements

| Measure | Definition | Source |
| --- | --- | --- |
| Task completion | The final-state check passes and the model claims success; a success claim with a failed check counts as an incorrect report | harness check |
| Input tokens | Sum of input tokens over every model request in the run, with cached input reported separately | model CLI usage events |
| Peak context | Largest single-request input, cached plus uncached | model CLI usage events |
| Output tokens | Sum over the run, including reasoning tokens when reported | model CLI usage events |
| Catalog cost | Input tokens of the first request for a one-word prompt, per model and interface | a dedicated calibration run |
| Payload bytes | Bytes of every MCP request and answer | stdio logging proxy |
| Latency | Wall time per run, and per MCP call | harness and proxy timestamps |
| Process communication overhead | Single-tool only: execution time minus the summed time of its operations, the cost of the interpreter process and its boundary | proxy timestamps and receipts |
| Operation calls | Native tool calls; single-tool operations dispatched inside programs, and executions | proxy log |

Payload bytes and token counts are reported side by side and never substituted for each other.

### Incorrect operation choices

A call counts as one incorrect operation choice when any of these holds:

1. The server rejects it: unknown tool or operation, invalid parameters, or a refused authority check the task did not set up.
2. It is a mutating operation that repeats an already successful effect under a new operation id.
3. It acts after an intervention ended the program or the user refused, before the model has reread the session.
4. It targets a reference from a Snapshot the model had been told was stale.

Rules 1 and 2 are classified mechanically from the proxy log and receipts. Rules 3 and 4 are classified from the same log against the task's scripted user timeline. Each classified call is listed in the raw results with its rule.

## Decision rule

- **Adopt** when the correctness gate passes and, for both models, the single-tool interface uses less median input tokens or makes fewer incorrect operation choices, with task completion no lower. Then make single-tool the default and keep native behind `CONTINGENCY_MCP_INTERFACE=native`.
- **Reject** when the correctness gate fails on a reproduced defect that the interface itself causes, or when the benefit gate fails for both models.
- **Blocked** when a prerequisite cannot be measured, such as missing token usage or a broken environment. The report names it, and the default does not change.

The maintainer reviews the report before any default changes.
