# Interface evaluation harness, round 3

2026-10-16. The harness is implemented. Exactly four cart model processes, four calibration model processes, and one paired overhead benchmark ran. Both single-tool cart runs passed their final-state checks. Both native cart attempts failed in driver setup and remain failures, without replacements. This round does not establish either adoption gate. Codex client-context isolation also remains unproven after a discovered host skill catalog leak.

## Implementation and conditions

Entry points are `bin/interface-eval.mjs <cart|calibration> <haiku|sol> <native|single-tool>` and `bin/interface-overhead.mjs`, run with `nub`. The sibling `interface-eval/` directory owns shared prompts, task checks and remaining-task prerequisites, driver isolation, stdio forwarding, Variable redaction, usage parsing, classification, isolation audits, and metric regression checks. `interface-eval/summarize.mjs` reparses retained evidence without launching models and writes `measurement.json`, `summary.json`, and `runs.jsonl`. Original `result.json` files remain intact.

Product source was unchanged. All model runs and the benchmark used the existing production `packages/cli/dist/index.js mcp` build on product commit `ae9c446e`, branch `feat/461-interface-evaluation`. No rebuild was needed or performed. Runtime versions were Node 24.16.0, Effect 4.0.1, OpenCode codemode 2.0.27, Playwright Core 1.64.0 with its installed Chromium, Claude Code 2.1.301, and Codex CLI 0.163.0. Each production process had its own ephemeral Workspace port and fresh Catalog Root. The static ecommerce pages came from the existing fixture, served on an ephemeral loopback port. The fixture was not changed.

The runner retains the production process after the model exits and checks that exact browser. Cart verification rereads the SKU list and checks the report names both requested items and claims a successful cart outcome. Natural-language claim detection is conservative; the two collected successful reports were also reviewed against the final Snapshots. One list item represents one fixture effect. Each extra item counts once under rule 2. Rules 3 and 4 require the remaining intervention timelines and are recorded as inapplicable here. Rule 1 reads server refusals and failed or rejected operation receipts, deduplicating the enclosing program diagnostic. Client-side denials are recorded separately.

The logging bridge measures UTF-8 bytes on the production stdio side before redaction. It separates model traffic from harness setup and final-state checks, records timestamps and per-call durations, and preserves request IDs across forwarding. Variable input values and Variable program text are redacted in the proxy journal. Product result `value` fields remain available for classification. Payload totals include initialization and discovery, not only tools/call. Operations count native tool calls or single-tool receipts; executions count `agent_code_execute` calls, including signature searches.

## Driver isolation and evidence

Claude's first attempted cart run used the requested safe mode. Its own debug log says `--mcp-config: server ignored (safe mode): contingency`, and `system/init` lists no tools or servers. That run also exposed a harness cwd error: its empty directory was under the checkout. It is an invalid-context failure, retained rather than replaced.

Subsequent Claude launches used a fresh empty directory under the system temporary directory, an environment allowlist, and:

```text
claude -p --model claude-haiku-5-5 --output-format stream-json --verbose
  --restricted --disable-slash-commands --strict-mcp-config --mcp-config <file>
  --tools "" --allowedTools mcp__contingency__* --setting-sources ""
  --no-session-persistence --debug-file <run-owned-file> <shared-prompt>
```

They set `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and `ENABLE_TOOL_SEARCH=false`. The run-owned `system/init` events list only Contingency tools, only the Contingency MCP server, and no skills. The debug logs say `project memory is off`. Three built-in Claude plugins remain listed; their presence is recorded. Existing OAuth remained usable. No auth contents were read, printed, or copied.

Codex launched in a fresh empty temporary cwd with:

```text
codex exec --json -m gpt-6.1-sol -c model_reasoning_effort="medium"
  --sandbox read-only --skip-git-repo-check --ignore-rules <shared-prompt>
```

Each `CODEX_HOME` initially contained only its Contingency server config and a symlink to `~/.codex/auth.json`. The symlink was removed during cleanup, without reading or copying its target. Logs and databases subsequently written by Codex remain as run-owned evidence. No parent-session environment variables were inherited. The first native cart attempt was denied by Codex before an MCP tools/call reached the server. The installed CLI's documented `default_tools_approval_mode = "approve"` was then set only for the isolated Contingency server, on both interfaces. The read-only sandbox and product Execution Boundaries remain in force. See the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The final audit found `<skills_instructions>` developer messages in all four Codex session logs. Those messages contain the host skill catalog despite the isolated home. Raw usage is measurable, but these runs do not satisfy the fixed client-context condition. Final driver code adds `--enable skip_host_skill_discovery -c project_doc_max_bytes=0` and audits the actual session messages. The installed CLI accepts these settings and reports discovery skipping enabled. A model run with that correction remains unverified, because all eight authorized model processes had already run. No ninth model process was launched.

Claude input is the sum of uncached, cache-read, and cache-write input for each unique request ID. Its final result event supplies total output, including thinking; assistant-event output counters are partial. Codex uses only `token_count.info.last_token_usage` events in its own `CODEX_HOME/sessions`, deduplicated by cumulative usage. Cached input and reasoning output are subsets of Codex totals, so neither is added twice. No missing usage was estimated from payload bytes.

## Smoke measurements

Input includes cached input. Wall time covers setup, the model, and final-state checks, before cleanup. R1 and R2 are incorrect-choice counts. R3 and R4 are inapplicable to these probes, recorded as null. Successful task completion and valid evaluation context are separate fields.

| Task | Model | Interface | Completed | Input | Cached | Peak | Output | Payload bytes | Wall s | MCP calls | Operations | R1 / R2 | Context valid |
| --- | --- | --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --- | --- |
| cart | haiku | native | no | 7,071 | 2,997 | 3,549 | 880 | 0 | 7.825 | 0 | 0 | 0 / 0 | no |
| calibration | haiku | native | yes | 31,427 | 0 | 31,427 | 4 | 94,240 | 3.557 | 0 | 0 | 0 / 0 | yes |
| cart | sol | native | no | 90,676 | 74,368 | 25,765 | 271 | 91,448 | 21.547 | 0 | 0 | 0 / 0 | no |
| cart | haiku | single-tool | yes | 171,507 | 146,281 | 25,210 | 2,681 | 100,317 | 29.277 | 9 | 7 | 0 / 0 | yes |
| cart | sol | single-tool | yes | 215,842 | 198,144 | 28,800 | 797 | 66,873 | 44.080 | 7 | 6 | 0 / 0 | no |
| calibration | haiku | single-tool | yes | 4,187 | 3,174 | 4,187 | 4 | 9,050 | 2.784 | 0 | 0 | 0 / 0 | yes |
| calibration | sol | native | yes | 14,787 | 12,288 | 14,787 | 5 | 91,448 | 9.450 | 0 | 0 | 0 / 0 | no |
| calibration | sol | single-tool | yes | 14,788 | 0 | 14,788 | 5 | 6,258 | 10.899 | 0 | 0 | 0 / 0 | no |

The native Haiku attempt had no Contingency tools. The native Sol attempt had one driver-denied `agent_run_start`; no tools/call reached Contingency. Neither is an incorrect server operation choice under rule 1. Both single-tool cart checks reread exactly `SKU ANVIL-001` and `SKU BENCH-002`. The Haiku run made nine executions containing seven operations; Sol made seven executions containing six operations. There were no extra fixture effects. The reported cart contents were reviewed against those final snapshots.

These failures and context differences prevent a matched completion or total-token comparison. They are not evidence that either interface is more correct.

## Calibration catalog costs

The dedicated prompt was `Reply with exactly one word: ready`. Catalog cost follows the plan: first-request input, including the driver's fixed context, rather than an estimate of schema-only tokens.

| Model | Native | Single-tool | Qualification                                |
| ----- | -----: | ----------: | -------------------------------------------- |
| haiku | 31,427 |       4,187 | Validated Claude isolation                   |
| sol   | 14,787 |      14,788 | Host skills loaded; context condition failed |

Claude tool search was disabled equally so its initial request included the advertised catalog. Codex uses dynamic tool discovery; its first request is almost identical across interfaces. Reported MCP initialization payloads still differ substantially. Neither payload difference substitutes for token usage.

## Paired overhead

No model ran during this benchmark. Two production processes held matched fresh Run sessions on the same fixture URL. Calls alternated interfaces, with the leading interface reversed on odd pairs. There were exactly 20 pairs per operation. Signature setup and Snapshot reads to obtain action references were outside the timed sample. Each single-tool sample was a one-operation program. Every action completed, and final independent Snapshots reported `20 items in cart` on both sides.

| Operation | Native median ms | Native p90 ms | Single median ms | Single p90 ms | Paired delta median ms | Paired delta p90 ms |
| --- | --: | --: | --: | --: | --: | --: |
| agent_session_get | 0.95 | 1.12 | 84.38 | 86.12 | 83.35 | 85.16 |
| agent_browser_act | 679.01 | 701.81 | 752.27 | 764.49 | 73.72 | 96.38 |

Median is the average of the two middle observations. P90 uses the nearest rank. Delta statistics come from each matched pair, not subtraction of the independent percentiles. This measures added end-to-end interpreter and dispatch latency on this machine, including copying and process startup. It does not isolate copying alone.

## Remaining tasks

The six remaining module entries fail closed and state their prerequisites. They do not claim to be runnable scenarios yet.

| Task | Required implementation |
| --- | --- |
| `checkout` | Seed declared secret Variable metadata. Supply privately through Workspace only after a request. Allow purchase Confirmation. Check one order and secret literal absence from every model-visible message. |
| `refuse` | Reuse checkout setup, refuse through Workspace, timestamp the refusal, check no order and a refusal report, and classify action-before-reread under rule 3. |
| `learn` | Seed a real ready Teaching Recording. Check the saved Flow Skill contract, parameterized inputs, and persisted catalog reread. |
| `dry-run` | Seed the Flow Skill and Teaching Recording, supply changed inputs, drive Verify through Workspace, and check a complete verified Summary and catalog state. |
| `takeover` | Take over through Workspace midway, change the cart, return control, timestamp changes and stale-reference notices, and check reread-before-action plus the final cart under rules 3 and 4. |
| `android` | Provide an explicitly authorized checkout device and installed fixture, then read submitted values from that device. No emulator was started in this round. |

The full matrix and scripted correctness gate were not run. No adoption, rejection, or default change is justified by this smoke. Future valid comparative runs require a fresh authorized run budget and confirmation that Codex no longer loads host skills.

## Verification and cleanup

`nub exec turbo run quality` passed with zero errors or warnings. Direct Oxlint and Oxfmt checks cover the hidden harness directory as well. `nub .cursor/skills/verify-contingency/bin/interface-eval/check.mjs` checks request deduplication, cached and reasoning subset accounting, missing usage, Variable redaction, receipt/program deduplication, and one count per extra fixture effect. A final production stdio transport proof, without a model or browser, checks concurrent request forwarding and string request-ID preservation. Later parser and classifier revisions reprocessed the original logs; they did not replace model runs.

Memory guards ran before every attempted run and throughout the benchmark. Swap remained zero, and free plus inactive memory stayed above 3 GB. Process manifests record direct children and observed descendants with owner, PID, start time, command, and stop operation. Interpreter receipts additionally retain short-lived interpreter PIDs and process exits. Cleanup signals only owned PIDs with matching start times. Each tracked listener is checked after shutdown. Temporary Catalog Roots and browser profiles were removed. Raw evidence remains under the gitignored artifact directory. The auth symlinks are absent.

The final batch audit checked 127 tracked PIDs, 82 interpreter PIDs from receipts, and 28 distinct ports across 11 attempt manifests, including the benchmark and two pre-driver setup failures. It found zero surviving tracked PIDs, zero live interpreter PIDs, and zero listening ports. The separate transport proof also has zero cleanup survivors and no listeners. No user-owned process was signaled.

Two calibration startup attempts failed before a model was launched: one due to a missing temporary-directory argument and one due to an incorrect Predicate helper name. Both are retained in the run index with `modelLaunched:false`, and both cleaned up. They are distinct from the eight model processes and are not replacement model results.

The plan amendments record the Claude safe-mode replacement, Claude output source, isolated Codex tool approval policy, and the discovered Codex context leak with its unverified correction. No gate, task list, incorrect-choice rule, decision rule, or matrix run count changed. No product files under `packages/` changed. Nothing was pushed and no PR was opened.

## Raw evidence

- [Run index](../artifacts/interface-eval/runs.jsonl), [recomputed summary](../artifacts/interface-eval/summary.json), and [cleanup audit](../artifacts/interface-eval/cleanup-audit.json).
- [Overhead result](../artifacts/interface-eval/2026-10-16T06-17-44-169Z-overhead/result.json) and [transport proof](../artifacts/interface-eval/transport-check/result.json).
- [2026-10-16T06-10-03-917Z-cart-haiku-native](../artifacts/interface-eval/2026-10-16T06-10-03-917Z-cart-haiku-native/measurement.json), with sibling driver output, proxy journal, usage events, isolation audit, and cleanup manifest.
- [2026-10-16T06-11-16-113Z-calibration-haiku-native](../artifacts/interface-eval/2026-10-16T06-11-16-113Z-calibration-haiku-native/measurement.json), with sibling driver output, proxy journal, usage events, isolation audit, and cleanup manifest.
- [2026-10-16T06-11-36-187Z-cart-sol-native](../artifacts/interface-eval/2026-10-16T06-11-36-187Z-cart-sol-native/measurement.json), with sibling driver output, proxy journal, usage events, isolation audit, and cleanup manifest.
- [2026-10-16T06-12-46-575Z-cart-haiku-single-tool](../artifacts/interface-eval/2026-10-16T06-12-46-575Z-cart-haiku-single-tool/measurement.json), with sibling driver output, proxy journal, usage events, isolation audit, and cleanup manifest.
- [2026-10-16T06-13-24-291Z-cart-sol-single-tool](../artifacts/interface-eval/2026-10-16T06-13-24-291Z-cart-sol-single-tool/measurement.json), with sibling driver output, proxy journal, usage events, isolation audit, and cleanup manifest.
- [2026-10-16T06-15-47-074Z-calibration-haiku-single-tool](../artifacts/interface-eval/2026-10-16T06-15-47-074Z-calibration-haiku-single-tool/measurement.json), with sibling driver output, proxy journal, usage events, isolation audit, and cleanup manifest.
- [2026-10-16T06-16-13-119Z-calibration-sol-native](../artifacts/interface-eval/2026-10-16T06-16-13-119Z-calibration-sol-native/measurement.json), with sibling driver output, proxy journal, usage events, isolation audit, and cleanup manifest.
- [2026-10-16T06-17-06-894Z-calibration-sol-single-tool](../artifacts/interface-eval/2026-10-16T06-17-06-894Z-calibration-sol-single-tool/measurement.json), with sibling driver output, proxy journal, usage events, isolation audit, and cleanup manifest.
