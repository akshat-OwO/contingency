# Agents learn of Session Events by waiting on the session

A user can verify a Flow Skill, return from Takeover, supply a Variable, or stop Teaching in the Workspace. Before this decision, the agent learned about those changes only when the user told it in the conversation. Now each such change becomes a **Session Event**, and the agent waits for one by calling `agent_session_get` with `afterCursor` and `waitMs`. No new tool is added. Verification stays available in both places: the user can verify in the Workspace or tell the agent, which calls `agent_flow_skill_decide`.

## Contract

- Every session-returning response carries an `eventCursor`. Waiting with `afterCursor` returns as soon as at least one Session Event is newer than the cursor, or when `waitMs` elapses. The server clamps `waitMs` to 50 seconds and defaults to about 45, because Codex abandons tool calls after 60 seconds by default and progress notifications cannot extend that.
- A wait returns the compact snapshot, the Session Events since the cursor, and the next cursor. Because the cursor comes from the agent, a lost response or a retried call loses nothing. This keeps the waiting call replay-safe like every other call (ADR 0026).
- Session Events live in a bounded in-memory log per Agent Session and die with it. A cursor older than the log returns the current snapshot with `eventsTruncated: true` and a fresh cursor. A cursor that names no known log is a conflict.
- The v1 events are `teaching-started`, `teaching-stopped`, `teaching-discarded`, `instruction-recorded`, `scan-requirement-recorded`, `takeover-started`, `takeover-returned`, `variable-supplied`, `variable-refused`, `dry-run-stopped`, `flow-skill-verified`, `flow-skill-rejected`, `cleanup-completed`, `cleanup-failed`, and `session-closed`. Boundary decisions are excluded because only the conversation resolves them.
- When a Dry Run passes, `agent_run_complete` sends one URL-mode elicitation that points at the Workspace. The client must have declared URL elicitation and negotiated a stateful revision. Opening the URL authorizes nothing, and a decline or cancel does not change the call's result.
- Request-then-wait replaces relayed answers, so `agent_run_variable_request` and `agent_teaching_setup_variable_request` merge into `agent_variable_request`.

## Considered options

- **Resource subscriptions** (`resources/subscribe` in 2025-11-25, `subscriptions/listen` in 2026-07-28): rejected for now. No confirmed client starts a model turn from `notifications/resources/updated`. Codex only logs the notification, and VS Code refreshes editor state. Revisit when a client is confirmed to wake the model.
- **MCP Tasks**: rejected. Task status notifications must not replace polling, model continuation stays under the host's control, and the 2026 extension changed the wire contract.
- **Claude Code channels** (`notifications/claude/channel`): the only confirmed way to inject an event into a model's context. It is a research preview, works only over stdio, and fails on 2026-07-28. Contingency adds it as an opt-in layer over the same Session Event log rather than as the primary mechanism.
- **A separate wait tool, or an event feed on `agent_session_history_get`**: rejected because each adds a tool or splits session reading across two calls. ADR 0045 sizes the catalog for the model.
- **Server-tracked delivery instead of a cursor**: rejected because a lost response would mark events delivered that the agent never saw.
