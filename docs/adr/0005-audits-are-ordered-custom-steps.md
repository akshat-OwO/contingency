# Audits are ordered custom Steps

> Partially superseded by [ADR 0008](./0008-performance-is-a-navigation-step-toggle.md): performance is no longer an Audit kind. Everything below holds for accessibility Audits.

Accessibility and performance Audits are standalone ordered Steps in a Flow, represented with Chrome Recorder's `customStep` shape using the name `contingency.audit` and a typed Audit kind in `parameters`. Create View appends an Audit Step where the author requests it instead of attaching Audit metadata to another browser-action Step. The CLI Runner will execute the Audit at that exact point and associate its Findings with the Audit Step.

## Consequences

- A Flow expresses when an Audit runs through ordinary Step order, so authors can add, inspect, delete, and undo Audit Steps like other Steps.
- Plain Chrome Recorder tools can still parse the document shape but cannot execute Contingency custom Steps without a Contingency Runner or compatible custom-step extension.
- Flow Pre-steps run before Audit Steps as well as browser-action Steps, except for the initial navigation. Per-Step Pre-steps remain available only on browser-action Steps.
- Existing per-Step Audit metadata is replaced by ordered Audit Steps.
