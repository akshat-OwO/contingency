# Agent Flow is compiled from a Demonstration

An **Agent Flow** is a schema-validated durable artifact compiled by an agent from a mixed-control **Demonstration**, not a mode of the existing deterministic **Flow**. The agent proposes objective-level Step boundaries, names, and descriptions; before verification, the user may merge, split, rename, or clarify them. Contingency derives each immutable, bounded **Evidence Slice** from the selected demonstrated action span rather than accepting agent-authored evidence. The sensitive full Trace remains a separate artifact and is not required for future execution. This keeps real teaching evidence close to each Step without binding a reusable Agent Flow to a movable or deletable Trace.

Compiler output enters the catalog only after schema validation. Validation failures return structured diagnostics to the agent for another attempt. A Verification Run must reproduce the demonstrated journey before approval. If verification fails, the agent may use its evidence to propose a changed draft, but that draft requires a new direct user authorization before another Verification Run; the approved revision remains untouched.

## Considered Options

- **Add agent intent to the existing Flow**: rejected because a Flow declares the ordered browser actions the Runner replays, while an Agent Flow gives the agent evidence from which it generates its own Run plan.
- **Reference the original Trace directly**: rejected because Traces are large, sensitive Run artifacts whose location and retention must not determine whether an Agent Flow can execute.
