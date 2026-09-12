# Agent View is separate from Audit View

> Superseded by [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) for new work: this decision belongs to the removed deterministic Flow and Audit View stack.

Agent-controlled work uses a dedicated local **Agent View** rather than extending Audit View. Agent View shows the live browser alongside Agent Step summaries, Agent Assessments, the action timeline, current controller, and intervention requests reported through MCP. The user may initiate Takeover at any moment and has priority over agent control; the agent may also request Takeover with a reason. Audit View remains the deterministic Flow execution and inspection interface.

The MCP start tool returns a loopback `/agent?session=<id>` URL that selects the new activity. The session id selects an Agent Session and is not an authentication token. The first version has no local login: the server binds only to loopback, rejects cross-origin mutations and WebSockets, and does not enable permissive CORS. Agent View may switch among only the running Agent Sessions owned by its MCP process.

An Agent Session is an ephemeral coordination envelope binding one Agent View, browser, and external agent to at most one active Teaching or Run activity. A user-initiated Takeover interrupts the in-flight action's Effect, waits for cleanup, disables further agent actions, and transfers exclusive control. If the browser already received the action, Agent View reports that it may have occurred because Takeover cannot undo it.

Agent View may close without pausing the Run. When intervention is needed, `request_takeover` pauses the Agent Session and returns its Agent View link and the reason immediately; the external agent gives the link to the user and ends its turn. A user may also ask the agent for the link and request Takeover through the conversation. After the user returns control in Agent View, the next agent turn reads the resumed Agent Session state.

After Teaching, Agent View presents the draft's Agent Steps, Variables, Domain Scope, Confirmation Steps, and Pending Decision status. [ADR 0037](0037-pending-decisions-relay-user-consent-over-mcp.md) partially supersedes the original direct controls: the user authorizes verification and approves a passed revision in the MCP conversation, and the external agent relays the explicit enum choice with the server-issued pending id. Agent View is a read-only mirror for those choices.

At Run completion, the Runner finalizes artifacts and closes the live browser; Agent View switches to the Run Summary and remains available until its Agent Session or MCP process closes. The live link then ends. A later `open_run` call launches Agent View in read-only mode for a persisted Run Summary and returns a new local link.
