# The MCP surface is sized for the model

> Extended by [ADR 0051](./0051-agents-learn-of-session-events-by-waiting.md). `agent_session_get` gains a cursor-based wait instead of a new tool, and the two Variable request tools merge into `agent_variable_request`.

Every MCP client that lists Contingency's tools pays for the emitted catalog. Every session-returning call repeats session state into the conversation. Between #326 and #331, the `tools/list` answer grew from 140,121 to 216,458 bytes, and nothing failed. Output schemas made up 84% of it: `agent_sessions_get` and `agent_flow_skill_dry_run_start` each inlined the whole session union, about 70 KB, and the Run Summary appeared twice inside it.

The surface now follows these rules:

- **Shared shapes are defined once per tool.** Output-only protocol schemas that recur carry an `identifier`, so each tool emits them once under `$defs`. Input schemas stay inline, because some clients handle `$ref` in arguments poorly.
- **Session snapshots and Run Summaries are not republished.** Tools that return one at their root already publish no output schema, because it is a union. Tools that nest one now publish that field as an opaque value and encode it with the protocol schema. The shape is documented once, in `@contingency/protocol`.
- **A budget test guards the catalog.** `tests/routes/mcp-catalog.test.ts` fails when the catalog exceeds 80,000 bytes or one tool exceeds 12,000 bytes.
- **Compatibility tools leave when nothing reaches them.** `agent_run_step_assess` is removed. No start path has created an ordered-Step Run since #327. Historical summaries still decode and open.
- **Session-returning tools accept `view: "compact"`.** The compact view is a projection computed on every read, never stored. It keeps open Pending Decisions, a paused Execution Boundary, Takeover, the newest attempt, the Run lifecycle, the assessment, and Variables. Older attempts and resolved decisions are counted, and `agent_session_history_get` pages them newest first. `full` stays the default.
- **Read-only tools say so.** They carry `readOnlyHint`, `destructiveHint: false`, and `idempotentHint`, so hosts can approve them or run them concurrently.
- **Habits go in server instructions.** Instructions loaded once per connection cover snapshot reuse, compact views, action sequences, and prompt completion. Each tool's description keeps that call's correctness rules.
- **Known form steps can be one call.** `agent_browser_act_sequence` performs up to five actions. Each action keeps its own operation id and passes every check `agent_browser_act` applies. The sequence is not atomic. It stops at an intervention, a refused or failed action, effect `none`, an unsettled Snapshot, or navigation before the last action. Earlier effects remain, and replaying the same ids replays them.
- **Newer protocol revisions are negotiable.** HTTP serves 2025-06-18, 2025-11-25, and the stateless 2026-07-28. Stdio serves both stateful revisions. A client that requests an unknown revision still receives 2025-06-18.
- **Sandboxed code orchestration is opt-in.** With `CONTINGENCY_MCP_CODE_MODE=true`, `agent_code_run` runs a short script in a QuickJS WebAssembly isolate. The script's only capability is `contingency.call` on read-only tools. It has budgets for calls, time, memory, and result size. The script cannot act in a browser, write files, reach the network, or resolve consent. The catalog leaves it out by default until measurements show it pays for itself.

The task proof in `verify-contingency` records per-tool call counts and answer sizes in `metrics.json`, plus full and compact session sizes. Later changes are measured against that baseline.
