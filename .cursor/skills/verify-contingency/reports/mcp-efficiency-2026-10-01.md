# MCP efficiency proof, 2026-10-01

This proof measures the MCP surface before and after [ADR 0045](../../../../docs/adr/0045-the-mcp-surface-is-sized-for-the-model.md). Each `tools/list` figure is the compact JSON size of the tool array, captured from the real HTTP layer.

| Measure | Before (0e54722) | After | Change |
| --- | --- | --- | --- |
| `tools/list` bytes, default catalog | 216,458 | 72,652 | −66% |
| Tools in the default catalog | 31 | 32 | `agent_run_step_assess` removed; `agent_session_history_get` and `agent_browser_act_sequence` added |
| Largest single tool | 72,797 (`agent_flow_skill_dry_run_start`) | under 9,100 (`agent_browser_act_sequence`) |  |
| Output schema bytes | 181,173 | 32,554 | −82% |
| `tools/list` with `CONTINGENCY_MCP_CODE_MODE=true` | n/a | 73,904 | `agent_code_run` added |

The combined task proof (`bin/task-proof.mjs`) passed with no blockers and wrote `artifacts/task-proof/metrics.json`:

- 113 MCP calls answered 284,251 bytes in total.
- Session-returning tools dominate: `agent_session_get` (58,556 bytes over 13 calls) and `agent_pending_decision_resolve` (56,971 bytes over 11 calls).
- The same live task session measured 9,499 bytes in the full view and 2,823 bytes in the compact view (−70%), with identical `pendingDecisions`.

These are wire bytes. Model-visible tokens depend on what the host sends to the model, and no tokenizer, latency, or task-success benchmark was collected. The proof drives the existing full-view path. Adopting `view:"compact"` in agents is the next measurable step.

Validation: forced CLI build, repository quality checks, all package type checks, 201 unit tests, and 66 integration tests across 20 files passed.
