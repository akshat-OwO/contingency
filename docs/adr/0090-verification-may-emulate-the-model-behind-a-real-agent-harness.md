---
status: proposed
---

# Verification may emulate the model behind a real Agent Harness

Today the only proofs that registration, harness launch, the getting-started read ([ADR 0069](./0069-agents-read-getting-started-before-acting.md)) and the single tool's description ([ADR 0072](./0072-single-tool-is-the-only-mcp-interface.md)) work end to end run a hosted model through a real Agent Harness. Those runs cost tokens and give different results each time, so they are rare. The vitest suites are cheaper, but they skip the harness entirely.

Verification may now point a real Agent Harness at an emulated model: the AI service of [vercel-labs/emulate](https://github.com/vercel-labs/emulate), whose rules return scripted tool calls. Those rules come from a recorded Scripted Agent transcript. Only the model is replaced. The Agent Harness, the MCP server, Agent Sessions, Playwright and the Workspace stay real, so verify-contingency's rule against mocking them still holds.

## Rules

- **Claude Code first.** Other harnesses are added only after the emulator answers every endpoint the harness calls.
- **Local and verify-contingency before CI.** CI depends on it only after the spike runs stable.
- **A pass proves the interface, not judgment.** An emulated run shows that a harness can reach, read, and call Contingency. Whether a real model chooses well stays a hosted-model evaluation.

## Considered options

- **Keep hosted models as the only end-to-end harness proof.** Rejected: too costly and nondeterministic to run on every change.
- **Replace the Agent Harness with a fake MCP client.** Rejected: the Scripted Agent already covers the MCP interface, and it skips registration and the harness's own tool handling, which are what this tier exists to prove.
