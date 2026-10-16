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
  - `gpt-6.1-sol` at `medium` reasoning through `codex exec`. Each records its CLI version.
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
| `cart` | Add two named products to the cart and report what the cart holds | none | cart contents and the reported contents |
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
| Process communication overhead | The added latency of one operation run as a one-operation program over the same operation called natively, measured on a read (`agent_session_get`) and an action (`agent_browser_act`), 20 paired calls each. The interface is fixed per process, so two production processes run side by side with matched fresh sessions on the same fixture page, and calls alternate between them | a scripted microbenchmark, not the model runs |
| Operation calls | Native tool calls; single-tool operations dispatched inside programs, and executions | proxy log |

Payload bytes and token counts are reported side by side and never substituted for each other.

### Incorrect operation choices

A call counts as one incorrect operation choice when any of these holds:

1. The server rejects it: unknown tool or operation, invalid parameters, or a refused authority check the task did not set up.
2. It repeats an already successful effect: the fixture's final state holds more of an effect than the task asked for, such as an extra cart item or a second order. Receipts do not carry dispatched arguments, so this is judged from the resulting state, identically for both interfaces, and counts once per extra effect.
3. It acts after an intervention ended the program or the user refused, before the model has reread the session.
4. It targets a reference from a Snapshot the model had been told was stale.

Rule 1 is classified mechanically from the proxy log and receipts, rule 2 from the final-state check. Rules 3 and 4 are classified from the same log against the task's scripted user timeline. Each classified call is listed in the raw results with its rule.

## Decision rule

- **Adopt** when the correctness gate passes and, for both models, the single-tool interface uses less median input tokens or makes fewer incorrect operation choices, with task completion no lower. Then make single-tool the default and keep native behind `CONTINGENCY_MCP_INTERFACE=native`.
- **Reject** when the correctness gate fails on a reproduced defect that the interface itself causes, or when the benefit gate fails for both models.
- **Blocked** when a prerequisite cannot be measured, such as missing token usage or a broken environment. The report names it, and the default does not change.

The maintainer reviews the report before any default changes.

## Amendments

- 2026-10-16, before any result: the overhead benchmark uses two side-by-side processes, because a process serves one interface. `cart` reports contents rather than a total, because the shop fixture has no prices. Codex reports usage per turn in `codex exec --json`, so its per-request usage and peak context come from the `token_count` events in the run's own Codex session log; if those are absent, Codex peak context is reported as missing.
- 2026-10-16, before any result: rule 2 is judged from the final state instead of the proxy log, because single-tool receipts omit dispatched arguments. Process communication overhead moved to a paired microbenchmark, because receipts carry no per-operation timings.

- 2026-10-16, during harness smoke: Claude 2.1.301 `--safe-mode` ignores explicit `--mcp-config` servers, confirmed by its debug warning and empty `system/init` tool list. Use `--restricted --setting-sources "" --strict-mcp-config --tools "" --disable-slash-commands`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in a fresh temporary cwd instead. Disable Claude tool search for both interfaces so calibration includes the advertised catalog. Keep the failed first smoke as a failure without a replacement run. Claude assistant events provide request input usage; use final `result.usage.output_tokens` for complete output usage because streamed assistant output counters are partial. These sources remain owned by the driver.

- 2026-10-16, during harness smoke: Codex defaults to prompting for the newly registered MCP tools, and `exec` cannot approve them under its default `never` policy. Set only the isolated Contingency server’s `default_tools_approval_mode = "approve"` for both interfaces, while retaining the read-only sandbox and the product’s own Execution Boundaries. Keep the failed first Codex cart smoke without replacement.

- 2026-10-16, after the eight allowed model processes: the isolated Codex session logs still contain a host skill catalog, so those collected runs do not establish the client-context condition. The driver now uses the installed CLI’s `--enable skip_host_skill_discovery` and `-c project_doc_max_bytes=0` and audits its actual session messages. That correction has not had another model run, because the smoke contract permits exactly eight. Raw usage remains reported with this evidence gap; it cannot support adoption.

- 2026-10-16, round 4 before new journey model results: checkout uses a disposable mock-order page because the shop had no order outcome. Delivery uses a fixed local form with the same city/area input contract as the shop. Teaching seeds use the real Workspace capture and existing `task-proof.mjs` claim/save lifecycle. Checkout uses its disposable verified-package convention. The user requests are the model's Variable request, irreversible purchase attempt, or Session Event wait after asking for Takeover or verification. Both interfaces use the same hooks and prompts. User actions use `control-contingency`'s browser command dispatcher. Canvas commands now wait for their input acknowledgments; Teaching Stop waits for the durable Session Event.
- 2026-10-16, round 4 during smoke: recognize the equivalent success wording "cart has" in the report check. Reparse retained final-state evidence for both interfaces; no replacement model is needed for that parser correction. The two Haiku cart attempts carry `harnessDefect:true` annotations for the original false negatives.
- 2026-10-16, round 4 after four Sol attempts: `skip_host_skill_discovery` and `project_doc_max_bytes=0` still leave host skill catalogs in actual session messages. Per-path disable overrides also failed to remove the catalog. The installed CLI's no-model `debug prompt-input` confirms `[skills] include_instructions=false` removes it. Use that setting identically for both interfaces and audit new session messages. Retain and annotate the four invalid-context attempts; the round's explicit harness-defect exception permits one additional attempt per affected cart/calibration × Sol × interface cell.
- 2026-10-16, round 4 after the first checkout pair: the ARIA capture raced private-field clearing after Supply. No MCP message exposed the literal, but the retained-text audit found it in that UI capture and scrubbed it. Keep both failed privacy results, annotate the harness defect, and wait for the private field to disappear before capturing. The authorized exception permits one additional attempt per checkout × Haiku × interface cell. Original results remain intact. No gate, decision rule, task list, incorrect-choice rule, or 84-run matrix count changes.

- 2026-10-16, round 4 final classifier review: use native request arguments or single-tool receipt order plus Acorn-parsed program targets for R3 and R4. Resolve constant aliases and fresh Snapshot derivations. Unresolved targets require review instead of silently receiving zero. Consecutive staleness notices retain the existing stale references. Reprocess original evidence and run the extended self-check; this changes measurement implementation, not the incorrect-choice rules.

- 2026-10-16, before any of their runs: two free supplementary drivers join the matrix through `opencode run --standalone --format json --auto` with an isolated config holding only the Contingency server: `opencode/glm-5.3-flash-free` and `opencode/deepseek-v4.1-flash-free`. They run the same seven tasks, three runs per cell, adding 84 runs. The decision rule is unchanged and still judged on Haiku and Sol. The supplementary models are reported per model; a result on them that contradicts the primary pair is reported as a limitation of the recommendation.

- 2026-10-16, during the matrix: 22 Sol runs ended when the Codex account hit its usage limit, 21 of them before the model's first request and one partway through. They measure no model behavior, so they are kept in the run index annotated `excluded` with that reason, and their cells are rerun after the limit resets. Exclusion is only for driver infrastructure failures with a provider error in the driver's own event stream, never for a model's failure.

- 2026-10-16, before any supplementary matrix run: OpenCode 2 presents every MCP tool through its own code-mode `execute` tool and has no switch to turn that off. Its free tier also refuses requests whose built-in tool list differs from the default, so built-in tools stay advertised with `ask` permission, which a headless run auto-rejects, and paths outside the run directory are denied. Claude Code instructions and skills are disabled with `OPENCODE_DISABLE_CLAUDE_CODE`. For GLM and DeepSeek the comparison is therefore OpenCode's code mode over the native catalog against OpenCode's code mode over the single tool. They show what the single tool changes for a client that already runs code mode, not the native catalog's context cost.
- 2026-10-16, matrix execution: to finish within usage windows, up to three lanes run at once, each with one model, MCP server, and browser; Android runs stay in one lane because there is one device. Token counts and incorrect choices are unaffected. Wall time is compared only between native and single-tool runs of the same lane, which alternate.
