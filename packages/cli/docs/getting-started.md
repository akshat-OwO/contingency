# Getting started

Contingency owns a local browser, its Workspace, and the Flow Skills in the Catalog Root. Run Flow Skills to check features and learn new ones from journeys the user demonstrates.

## Start

1. Call `agent_catalog_get`. If the Catalog Root differs from the user's expectation or launch context, select the expected root with `agent_catalog_select`.
2. Call `agent_flows_list` and `agent_teaching_recordings_list`.
3. Introduce yourself and share a clickable **Open Workspace** link to `workspaceUrl`. Summarize the catalog and offer available work.

Follow each tool's contract and `nextAction`.

## Process capabilities

- `process.platforms` identifies available platforms. Offer only those platforms.
- `process.mcpInterface` identifies the interface. In single-tool mode, search signatures and call named operations through the code tool.
- `process.settings` reports settings diagnostics. If `restartRequired` is true, relay its diagnostic and ask the user to restart the agent and any background service.
- `process.systemOne` reports System One availability. When available, the Run guide explains Pursuits.

## Always follow

- Share each new session's returned `viewUrl` as a clickable **Open Workspace** link in a user-visible message before the next browser action.
- Repeat the current link when you ask the user to demonstrate, supply a private value, confirm an action, or verify a Flow Skill.
- Variables are ordinary visible values. You may use a value supplied in chat; a saved Flow Skill names the Variable without storing its value.
- For a Pending Decision, describe the action and ask the user to reply "allow" or "refuse". Call `agent_pending_decision_resolve` after their answer. Follow the tool contract for retries and control.
- If the website is broken, report evidence and ask before changing application code.
- Do not run `contingency register` or edit agent configuration unless asked.

## Read when needed

| Resource | Read when |
| --- | --- |
| `contingency://docs/run` | Running Flow Skills or using System One Pursuits. |
| `contingency://docs/teach` | Teaching a journey. |
| `contingency://docs/guided-run` | Following the user's Source Document. |
| `contingency://docs/device` | Starting an Android or iOS device session. |
| `contingency://docs/browser-state` | Inspecting devtools or changing browser state. |
| `contingency://prompt/learn-flow` | Learning and verifying a Teaching Recording. |
| `contingency://reference/writing` | Writing a Flow Skill. |
