---
status: accepted
---

# Evaluate one code tool for all agent capabilities

Contingency will evaluate an agent interface that exposes one code execution tool and makes every Contingency capability callable inside its programs. The hypothesis is that a smaller initial tool catalog reduces incorrect operation choices and context usage without reducing task completion or reliable recovery. A successful evaluation, rather than tool count alone, determines whether this interface becomes the default.

The proposal reopens [ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md), which limits code mode to opt-in, read-only orchestration. Every underlying operation must retain its parameter validation, authority checks, and operation identity. Code execution does not grant authority beyond the requested task or the existing Execution Boundary.

## Agreed design

The execution tool's instructions explain how to search function signatures. The agent searches through one execution call, reads the returned signatures, and submits its operation program in a separate execution call.

User intervention ends the current program. The runtime returns the Pending Decision and receipts for completed actions. After the user responds, the agent submits a new program to resume the exact attempt and inspect the result. Completed actions remain completed, as required by [ADR 0052](./0052-workspace-boundary-decisions-resume-stored-attempts.md).

OpenCode's interpreter is the only replacement runtime candidate in this evaluation. The existing native tool interface remains the behavioral comparison for the single-tool hypothesis.

Every execution starts with fresh program state. Program variables do not survive between calls. The Agent Session and Run retain their existing lifecycles.

The interpreter runs in a separate process. Contingency's server owns tool dispatch, parameter validation, authority checks, and action receipts. The interpreter requests operations through a validated process boundary and receives their results. Resource limits must be enforceable before adoption. Process isolation alone does not establish a memory limit.

This boundary adds data-copying overhead. The evaluation must measure that cost alongside the single-tool interface's context and operation-choice benefits.

## Adoption criteria

The single-tool interface becomes the default only if it meets both criteria:

- It completes the representative journeys supported by the native tools, including Teaching, Runs, Confirmation, Takeover, and recovery. The evaluation must show no observed regression in action correctness or recovery.
- It measurably reduces model context usage or incorrect operation choices compared with the native interface.

## Evaluation work

The design direction is settled, but runtime feasibility and adoption remain unproven. The evaluation must establish the following:

- Compatibility between OpenCode's interpreter and Contingency's installed Effect version and release packaging.
- Enforceable memory limits and reliable termination of an unresponsive interpreter, with completed server-side effects and receipts preserved.
- Strict operation validation, fresh program state, separate search and execution calls, and delivery of screenshots and other evidence outside the program's data values.
- Long session waits under [ADR 0055](./0055-agents-learn-of-session-events-by-waiting.md), cancellation, and termination on user intervention without dispatching later program actions.
- Task completion, recovery, model context usage, incorrect operation choices, and process communication overhead compared with the existing native interface.

OpenCode's interpreter creates fresh execution state in the host process and applies output limits after computing the result. Its public limits cover time, tool calls, and retained output, but expose no heap budget. These source findings do not establish runtime compatibility or prove that the adoption criteria pass. See upstream [execution state and output bounding](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/src/interpreter/execute.ts) and [execution limits](https://github.com/anomalyco/opencode/blob/dev/packages/codemode/src/codemode.ts).

This decision accepts the design and evaluation scope. Changing the default interface requires passing the adoption criteria.

## Outcome

The [#461 evaluation](../../.cursor/skills/verify-contingency/reports/interface-evaluation-2026-10-16.md) passed both criteria. Every scripted journey and recovery proof passed on both interfaces with no behavioral difference. Both evaluated models made fewer incorrect operation choices with the single tool (Haiku 7 against 19, Sol 3 against 16) at no lower task completion. Context usage fell 38% for a client that sends the full catalog and rose 33% for one that loads tools on demand. The single tool is therefore the default, and `CONTINGENCY_MCP_INTERFACE=native` keeps the native catalog for clients it suits better.
