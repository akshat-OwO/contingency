---
status: accepted
---

# Single-tool is the only MCP interface

Contingency exposes every supported capability through `agent_code_execute` on both HTTP and stdio. This supersedes the decision in [ADR 0059](./0059-evaluate-one-code-tool-for-all-agent-capabilities.md) to retain native tool registration, and the native registration rules in [ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md). Supporting one interface removes duplicate registration paths and makes all clients use the same operation discovery and execution contract.

The ADR 0059 evaluation found 38% lower context usage for full-catalog clients and 33% higher context usage for clients loading tools on demand. Both evaluated models made fewer incorrect operation choices with no lower task completion. We accept the on-demand context cost and withdraw the native option.

## Consequences

- Removal is immediate, with no deprecation period or compatibility layer. Existing native client configurations break.
- Remove `mcp.interface` from config.json, including explicit `"single-tool"` values. Strict settings validation rejects the obsolete property. Remove `CONTINGENCY_MCP_INTERFACE` from the environment; it no longer selects an interface.
- Process diagnostics no longer report `mcpInterface` or `settings.fileInterface` because there is no interface choice.
- Shared operation definitions, validation, handlers, resources, and prompts remain. Native registration wrappers are removed; supported capabilities remain callable through the code tool.
- Current tests, release verification, and verification recipes exercise single-tool. Historical evaluation reports retain their original results.
