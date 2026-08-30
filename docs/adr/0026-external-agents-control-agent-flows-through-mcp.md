# External agents control Agent Flows through MCP

An external agent controls Teaching and Interactive Runs through Contingency's MCP server. The MCP server exposes session-scoped tools for catalog search, browser observation and action, user intervention, Agent Assessment recording, Agent Flow validation and approval, and Run Summary generation. Contingency owns browser and session state, schema validation, persistence, recording, the Execution Boundary, and confirmation before sensitive artifacts leave Contingency. The CLI uses the same underlying services rather than implementing another execution path.

The first version launches one local MCP server process per agent client. Each process owns only its sessions and acquires their browsers, contexts, pages, streams, temporary files, and locks with Effect scopes. Normal completion, failure, interruption, and `SIGINT` or `SIGTERM` close those scopes, finalize available artifacts, mark unfinished work interrupted, and release the owned resources. Catalogs, Agent Flows, Evidence Slices, approvals, completed Runs, and retained artifacts are durable and never part of shutdown cleanup. On startup, Contingency removes only stale temporary resources carrying an ownership marker for a dead MCP process; it does not resume the interrupted activity.

Every mutating MCP call carries an operation id. Repeating an id returns the recorded result rather than executing the browser action, confirmation, catalog mutation, or destructive operation again. Runs record the MCP client name and version automatically and store provider or model metadata when the client reports it; reported model metadata is explicitly unverified.

## Considered Options

- **Embed an agent loop in Contingency**: rejected because it would bind Agent Flows to one model host and duplicate orchestration already supplied by MCP clients.
- **Expose Playwright or CDP directly**: rejected because raw browser access could bypass Contingency's recording, lifecycle, and artifact guarantees.
- **Expose only a high-level run tool**: rejected because the external agent must own planning, observation, interaction, and its generated to-do list.
