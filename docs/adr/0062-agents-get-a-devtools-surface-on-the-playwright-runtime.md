---
status: proposed
---

# Agents get a devtools surface on the Playwright runtime

Amended by [ADR 0068](./0068-every-run-has-the-full-devtools-surface.md).

An agent can act, take Browser Snapshots and screenshots, and run scans, but it cannot see network traffic, console output, cookies, or storage, and it cannot change them. Contingency will give agents the observation and modification capabilities a browser's developer tools offer, built on the existing Playwright runtime from [ADR 0012](./0012-playwright-is-the-in-process-browser-runtime.md). agent-browser 0.39.1 now covers most of the gaps ADR 0012 recorded, but it still has no in-process library. Adopting it would reintroduce a command boundary between processes: a 30-second IPC read limit, `outcome_unknown` for page-changing commands, and private input crossing a process boundary. Its command list serves as the feature checklist instead.

## Authority by activity

| Activity | Observe | Emulation changes | Cookie and storage writes | Routes, headers, mutating eval |
| --- | --- | --- | --- | --- |
| Interactive Run | Yes | Yes | Yes | Yes |
| Teaching setup | Yes | Yes | Yes | No |
| Dry Run | Yes | No | No | No |

A Dry Run starts in a fresh context under its saved Emulation, so a pass still means the Flow Skill works without help. Teaching setup may prepare state that a user could create, but nothing that fakes the network, because a mock still active at Start would teach the journey against fake data.

## Rules

- **Browser Modifications are evidence.** Every agent change that a user could not make through ordinary interaction is recorded in the Run Summary and shown in the Workspace dock. It persists until the agent removes it or the Run ends, including across Flow Skills that share the Run's context. An Agent Assessment is read in light of these changes rather than capped by them. A change the user makes during Takeover is a user action.
- **The agent sees a redacted projection.** Credential headers, cookie values, and secret Variable values are masked. Response bodies are returned on request, bounded in size, and scrubbed of secret Variable values. The Trace still never reaches an agent.
- **Network metadata is always on.** Each tab keeps a bounded buffer of request metadata from Run start. HAR capture with bodies is explicit.
- **Domain Scope bounds writes, not routes.** Cookie and storage writes target Domain Scope hosts. Routes may mock or block any URL, because a mocked request does not leave the browser. Requests the agent sends itself, such as an eval `fetch`, stay within the Domain Scope.
- **Eval that changes the page needs Confirmation.** Read-only evaluation runs freely and aborts on side effects. Evaluation that changes the page requires Confirmation for each attempt, because Contingency cannot tell whether a script performs an irreversible action.
- **Page zoom and text scale join Emulation.** Page zoom reflows the layout as Chrome's zoom does, from 25% to 500%. Text scale is a percentage of the 16px default font size, from 50% to 300%, and the agent and Workspace can read its current value. Both can be saved with a Flow Skill and are reproduced by its Dry Run. A mid-Run change is a Browser Modification. Emulation stays fixed from Start to Stop during Teaching recording. Pinch zoom is not supported.
- **The code tool carries the surface.** The operations are callable from `agent_code_execute`. The native interface, retained as the [ADR 0059](./0059-evaluate-one-code-tool-for-all-agent-capabilities.md) baseline, reports them as unavailable, so its [ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md) budget is unaffected.
- **The user gets matching views.** The Workspace Emulation panel gains page zoom and text scale, and the Workspace gains read-only network and console panels.

## Out of scope

Raw CDP access is refused because it could disable the Execution Boundary's own guards. Android refuses these capabilities as documented limits. Browser Checks still come only from Browser Attachments chosen during Teaching.

## Considered Options

- **Adopt agent-browser like agent-device**: rejected. agent-device has a typed Node client, while agent-browser is driven only through its CLI, daemon IPC, or MCP.
- **Allow every change in Dry Runs and record it**: rejected. A mocked response can make any outcome pass, so verification would depend on reading the record.
- **Raw unredacted network access**: rejected. Request headers and bodies routinely carry credentials that would enter the conversation.
