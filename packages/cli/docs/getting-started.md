# Getting started

Contingency owns a local browser, its Workspace, and the Flows in the Catalog Root. Run Flows to check features and learn new ones from journeys the user demonstrates.

## Start

1. Call `agent_catalog_get`. If the Catalog Root differs from the user's expectation or launch context, select the expected root with `agent_catalog_select`.
2. Call `agent_flows_list` and `agent_teaching_recordings_list`.
3. Share a clickable **Open Workspace** link to `workspaceUrl`. Summarize the catalog and offer available work.

Follow each tool's contract and `nextAction`.

A session started with `contingency start` adds a **This session** section at the end of this guide. Follow it after these steps.

## Process capabilities

- `process.platforms` identifies available platforms. Offer only those platforms.
- Search signatures and call named operations through `agent_code_execute`.
- `process.settings` reports settings diagnostics. If `restartRequired` is true, relay its diagnostic and ask the user to restart the agent and any background service.
- `process.systemOne` reports System One availability. When available, the Run guide explains Pursuits.

## Always follow

- Share each new session's returned `viewUrl` as a clickable **Open Workspace** link in a user-visible message before the next browser action.
- Share the Dry Run `viewUrl` from `agent_run_complete` before asking the user to verify or reject. Use `open_recording(recordingId)` to reopen its Summary and saved decision after sessions or the MCP process exit.
- Repeat the current link when you ask the user to demonstrate, supply a private value, confirm an action, or verify a Flow.
- Variables are ordinary visible values. You may use a value supplied in chat; a saved Flow names the Variable without storing its value.
- For a Pending Decision, describe the action and ask the user to reply "allow" or "refuse". Call `agent_pending_decision_resolve` after their answer. Follow the tool contract for retries and control.
- If the website is broken, report evidence and ask before changing application code.
- Do not run `contingency register` or edit agent configuration unless asked.

## Read when needed

| Resource | Read when |
| --- | --- |
| `contingency://docs/run` | Running Flows or using System One Pursuits. |
| `contingency://docs/teach` | Teaching a journey. |
| `contingency://docs/guided-run` | Following the user's Source Document. |
| `contingency://docs/device` | Starting an Android or iOS device session. |
| `contingency://docs/browser-state` | Inspecting devtools or changing browser state. |
| `contingency://prompt/learn-flow` | Learning and verifying a Teaching Recording. |
| `contingency://reference/writing` | Writing a Flow. |

## Catalog layout

The Catalog Root defaults to the project’s `contingency/` directory. Open **Flows** in Workspace to browse its Group tree in the **Flows Drawer**. Groups are plain directories and may nest.

Each Flow has `contingency/<group…>/<flow>/flow.md`, optional supporting Markdown, `recordings/`, and `runs/`. A Run started with no Flow or several Flows belongs in `contingency/runs/`. The read-only user catalog remains `~/.contingency`.

Search signatures use TypeScript with JSDoc constraints, such as `@maxLength 200`.

In signatures, omitted non-literal string minLength means 1; `@minLength 0` imposes no minimum. Omitted maxLength means no length limit.

Schema annotations that repeat field names are omitted. Patterns remain literal unless the description includes the exact pattern.

Parameter types and validation remain unchanged.

Signatures declare result types. All root keys remain visible, with more nested detail for browser actions and Snapshots. In result types, `unknown` marks a value elided for size; read it at runtime or in the topic docs.

Nested objects and arrays become `unknown` at the depth limit. An intervention's `action` repeats the action you sent, so it is `unknown` too.

Untagged object alternatives share one envelope, so result types omit correlations between those fields. Result types omit validation constraints.
