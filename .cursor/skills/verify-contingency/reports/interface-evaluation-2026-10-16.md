# Native versus single-tool evaluation, 2026-10-16 (#461)

**Recommendation: adopt, under the decision rule recorded before any result.** The single-tool interface passed every scripted correctness proof that native passed, with no behavioral difference. For both primary models it made fewer incorrect operation choices, and its task completion was no lower. For Haiku it also used 38% fewer input tokens. For Sol it used 33% more. The supplementary DeepSeek runs, under OpenCode's own code mode, contradict the token and choice results; that is a limitation of the recommendation.

The plan, with every amendment and its reason, is [interface-evaluation-plan.md](interface-evaluation-plan.md). Each amendment predates the runs it governs.

## Conditions

- **Build.** One production CLI build at harness revisions `bb775c94` and `cade5e72`. The later revision changed only the OpenCode driver and plan, so both count as one matrix. Product code under `packages/` did not change during the evaluation. The interface is chosen by `CONTINGENCY_MCP_INTERFACE`.
- **Runtime.** Node 24.16.0, Effect 4.0.1, OpenCode codemode 2.0.27, Playwright Core 1.64.0 with its Chromium. Android ran on the Pixel_9 API 36 emulator.
- **Drivers.** These were the models under test:
  - `claude-haiku-5-5`: Claude Code 2.1.301, restricted mode, only the Contingency server, no instructions or memory.
  - `gpt-6.1-sol` at medium reasoning: Codex CLI 0.163.0, an isolated `CODEX_HOME`, no host skills.
  - Supplementary: `opencode/deepseek-v4.1-flash-free` and `opencode/glm-5.3-flash-free` on OpenCode 2.0.30.

  Every run started in a fresh empty directory with a fresh Catalog Root, and its context audit passed.

- **Tasks.** The seven tasks, prompts, and final-state checks are in the plan, and the prompts are in `bin/interface-eval/prompts.json`. Interventions came from a scripted user acting in the Workspace.
- **Counts.** Three matched runs per task, interface, and model, interleaving native and single-tool.
  - Primary models: all 84 runs.
  - DeepSeek: 31 of 42 runs.
  - GLM: 10 of 42 runs. The free tier's rate limit stopped both supplementary models.
- **Exclusions.** 48 runs were excluded: 22 Codex usage-limit failures, 25 OpenCode free-tier `FreeUsageLimitError` failures, and 1 run marked as a harness defect. Each failure is a provider error in the driver's own event stream. None of them measured model behavior, and each is kept in `artifacts/interface-eval/aggregate.json` with its reason. No failure caused by the model was excluded or replaced.

- **Classifier review.** PR #504's review found that a receipt could be matched to a call in an unexecuted branch, and that runs needing manual review were aggregated as zero errors. Receipts are now matched by position only in straight-line code, and any other match needs review. Targets written in a branch, by a property write, or by a mutating call are unresolved, including writes into Snapshot data or through an alias. A write the classifier cannot trace, such as through a callback parameter, a destructuring pattern, or a redeclared name, makes every target in the program unresolved. An unresolved run marks the benefit gate incomplete. Reprocessing all retained evidence with the fixed classifier found 0 unresolved runs and changed no cell.

## Gate 1: correctness

Each scripted proof ran once per interface on the final harness revision. Evidence is in [round 6](interface-evaluation-round-6.md).

| Proof | Native | Single-tool |
| --- | --- | --- |
| Combined task proof: Teaching, Flow Skill learning, Dry Run, Verify and Reject, Interactive Run, secret Variables, Confirmation, Takeover, closure, process exit, Cleanup, restart | Pass, 0 blockers | Pass, 0 blockers |
| Session Events phases and long wait | Pass, 45,093 ms | Pass, 45,008 ms |
| Execution Boundary: nothing dispatched after intervention; one dispatch across concurrent resumes and replay | Pass | Pass |
| Cancellation during an action: the uncertain replay is refused and the fixture sees one request | Pass | Pass |
| Deadline and memory limit after an effect | Not applicable | Pass |
| Android: one action and one intervention | Pass | Pass |

**The gate passes.** No proof showed a dispatched action, receipt, or recovery outcome on single-tool that native did not show. Resource enforcement and packaging passed in #459 and #460.

## Gate 2: benefit

The tables give the median per cell of three runs. Input includes cached input. "Wrong" counts incorrect operation choices under rules 1–4. Every one observed was rule 1: a server rejection, mostly invalid parameters.

### Haiku 5.5

| Task | Done N / S | Input N | Input S | Peak N | Peak S | Wrong N / S |
| --- | --- | --: | --: | --: | --: | --- |
| cart | 3/3 · 3/3 | 276,049 | 146,628 | 37,841 | 22,570 | 2 / 0 |
| checkout | 2/3 · 3/3 | 482,210 | 294,652 | 42,949 | 30,499 | 3 / 1 |
| refuse | 3/3 · 3/3 | 399,356 | 331,475 | 41,935 | 32,222 | 2 / 0 |
| learn | 3/3 · 3/3 | 208,291 | 119,466 | 38,398 | 20,870 | 0 / 0 |
| dry-run | 3/3 · 3/3 | 449,889 | 236,287 | 43,817 | 27,875 | 5 / 3 |
| takeover | 3/3 · 3/3 | 487,314 | 279,509 | 43,600 | 28,318 | 4 / 0 |
| android | 3/3 · 3/3 | 399,934 | 254,624 | 67,321 | 25,290 | 3 / 3 |
| **Total** | **20/21 · 21/21** | **2,703,043** | **1,662,641** |  |  | **19 / 7** |

The single tool used less input on all seven tasks and had a lower peak context on all seven. Its first request costs 4,187 tokens, against 31,427 for the native catalog. Output rose about a quarter.

### Sol 6.1, medium

| Task | Done N / S | Input N | Input S | Peak N | Peak S | Wrong N / S |
| --- | --- | --: | --: | --: | --: | --- |
| cart | 3/3 · 3/3 | 202,393 | 357,088 | 30,327 | 30,645 | 2 / 0 |
| checkout | 2/3 · 3/3 | 653,095 | 864,638 | 43,296 | 43,140 | 0 / 0 |
| refuse | 3/3 · 3/3 | 537,800 | 715,968 | 42,553 | 47,253 | 3 / 2 |
| learn | 3/3 · 3/3 | 387,758 | 434,050 | 53,521 | 52,905 | 0 / 0 |
| dry-run | 3/3 · 3/3 | 296,006 | 661,826 | 38,013 | 49,408 | 0 / 0 |
| takeover | 3/3 · 3/3 | 370,869 | 507,160 | 35,894 | 40,358 | 3 / 0 |
| android | 3/3 · 3/3 | 470,301 | 340,729 | 44,741 | 34,155 | 8 / 1 |
| **Total** | **20/21 · 21/21** | **2,918,222** | **3,881,459** |  |  | **16 / 3** |

The single tool made fewer incorrect choices, 3 against 16. Half of the native errors were invalid `agent_android_workspace` commands. It used more input on six of seven tasks. Codex loads tools on demand, so the native catalog never enters its first request: both interfaces cost about 14,790 tokens there. The single tool's extra signature searches and programs therefore add requests without removing catalog cost.

### Supplementary models

These ran under OpenCode, which wraps every MCP tool in its own code-mode tool, so their comparison is code mode against code mode over one tool.

| Model | Runs N / S | Done N / S | Input N | Input S | Wrong N / S |
| --- | --- | --- | --: | --: | --- |
| DeepSeek v4.1 Flash | 16 / 15 | 16 · 15 | 3,923,438 | 6,501,713 | 4 / 9 |
| GLM 5.3 Flash, 3 tasks only | 5 / 5 | 4 · 3 | 1,694,823 | 385,235 | 1 / 4 |

DeepSeek used 66% more input and made more incorrect choices with the single tool, which nested inside OpenCode's code mode. The GLM sample is too small to read either way.

### Latency and overhead

- **Per call.** A one-operation program adds a median 83 ms to `agent_session_get` and 74 ms to `agent_browser_act` (20 paired calls each; [round 3](interface-evaluation-round-3.md)). A click is about 680 ms natively.
- **Per run.** Wall time per run rose 18% for Haiku and 23% for Sol, summed over cell medians. Program writing and signature searches add model turns.

## Decision

The rule recorded before any result was: adopt when the correctness gate passes and, for both models, the single tool uses less median input or makes fewer incorrect choices, with completion no lower.

| Model | Less input | Fewer incorrect choices | Completion no lower | Rule |
| --- | --- | --- | --- | --- |
| Haiku | Yes, 7 of 7 tasks | Yes, 7 vs 19 | Yes, 21 vs 20 | Pass |
| Sol | No, 1 of 7 tasks | Yes, 3 vs 16 | Yes, 21 vs 20 | Pass |

Both gates pass, so **adopt.** Under the plan, single-tool becomes the default and native stays available behind `CONTINGENCY_MCP_INTERFACE=native`, after catalog and registration behavior are verified on the final diff.

## Limitations

- **The token benefit depends on the client.** It is large for clients that send the full catalog (Claude Code) and negative for one that loads tools on demand (Codex) or wraps MCP in its own code mode (OpenCode with DeepSeek). The choice benefit held for both primary models.
- **The sample is small.** Three runs per cell gives no statistical confidence. Incorrect choices are few per cell, and Sol's difference rests mostly on Android.
- **Two models are primary.** DeepSeek contradicts both measures. GLM is incomplete because its free tier was rate-limited.
- **Latency is higher.** Single-tool runs take about a fifth longer.
- **Supplementary context is not fully audited.** OpenCode exports no system prompt, so its context audit checks the server list, tools used, and working directory only.
