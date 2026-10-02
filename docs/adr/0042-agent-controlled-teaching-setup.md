# An agent may prepare a Teaching browser before recording

An agent-opened Teaching session starts in `setup` with agent control. A Workspace-opened Teaching session starts in `setup` with user control. The agent may navigate and prepare prerequisites during setup, then explicitly hands control to the user. Only the user can start recording, and Start is unavailable while the agent holds the browser. Once control passes to the user, the agent cannot take it back during that Teaching session. Recording remains user-led, and setup activity remains outside every Teaching artifact.

This lets an agent handle repetitive prerequisites without turning them into demonstrated steps. A Run-to-Teaching conversion would join two different activity lifecycles and is unnecessary for this use case. The control handoff also preserves a clear point at which the user takes responsibility for the demonstrated journey. This decision supersedes the setup portion of the user-only Teaching rule in [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) while retaining its user-led recording rule and the capture boundary in [ADR 0039](./0039-flow-skills-are-learned-from-temporary-teaching-recordings.md).

## Private inputs during setup

Accepted in [#335](https://github.com/akshat-OwO/contingency/issues/335).

An agent may request a Setup Variable on demand by name and purpose while it holds Teaching setup. The user supplies or refuses the value directly in Workspace. The agent sees the name, purpose, and supply status, and enters a supplied value by reference. No saved Flow Skill is required, and setup inputs belong to the Agent Session rather than a Flow Skill.

A supplied Setup Variable remains usable for retries until handoff. An explicit request for a fresh value replaces the previous usable value; replaying the same operation does not request another value or repeat an entry. Values remain private across requests, replacements, failures, and refusals.

Setup handoff ends access to these Variables and cancels outstanding requests. Browser authentication remains in place, and masking continues for values already entered or reflected in the Page. Transient redaction information may remain for the lifetime of the Agent Session, but setup credentials are not persisted for reuse. Session closure or process exit ends their lifetime.

Setup Variable declarations and values do not become recorded inputs or automatically enter the learned Flow Skill. Setup actions remain outside the Teaching Recording. If the demonstrated journey needs a recorded Variable, it uses the existing user-led Teaching input path with an independent declaration and supply.

This extends private input support without changing control ownership or converting a Run into Teaching. Workspace supply avoids requiring the user to reveal a private value in the agent conversation. Session scope allows authentication setup before a Flow Skill exists, while the handoff boundary prevents setup credentials from becoming reusable Flow Skill inputs.
