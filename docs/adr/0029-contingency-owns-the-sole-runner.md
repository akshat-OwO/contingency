# Contingency owns the sole Runner

> Supersedes [ADR 0002](./0002-cli-is-the-sole-runner.md).

Contingency owns one **Runner** for deterministic Flows and Agent Flows. The CLI, web UI, and MCP server are adapters over that engine and do not construct Runs or operate Playwright independently. During an agent-controlled Run, the external agent supplies observations, browser actions, interventions, and Agent Assessments through MCP while the Runner owns lifecycle, Agent Step order, Variables, configurable Step and Run ceilings, the Execution Boundary, Trace and video capture, Run history, and cleanup. Reaching a hard ceiling records a `timed-out` execution outcome, interrupts the active action, finalizes available evidence, and leaves coverage incomplete without fabricating an Agent Assessment.

The external agent decides whether to retry ordinary observations and reversible browser actions within those ceilings; the Runner records every attempt. Only a `working` Agent Assessment advances an Agent Flow. Any other assessment or a timeout ends that Agent Flow, leaves later Steps unexecuted, and marks coverage incomplete. After a Suite member fails, the agent pauses and asks the user whether to retry that member in a fresh context, continue to the next member, or stop; Suite Setup failure still stops all members.

This extends the existing one-engine rule instead of creating an Agent Runner. The CLI no longer owns the Runner as a product boundary; it hosts the same Runner services used by MCP and the web UI.
