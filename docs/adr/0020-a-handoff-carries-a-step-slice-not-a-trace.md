# A Handoff carries a Step slice, not the whole trace

> Amends [ADR 0003](./0003-fixes-via-external-handoff.md).

A Handoff may include the failing Step's before and after snapshot drawn from the Run's Trace, and never the Trace itself.

## Consequences

- **This is a security boundary, not a size optimisation.** A Trace is unredacted and holds full DOM snapshots and network payloads, including secret Variable values typed into fields ([ADR 0014](./0014-artifacts-are-run-properties.md)). A Handoff is by definition a payload built to be sent to an external agent ([ADR 0003](./0003-fixes-via-external-handoff.md)), so referencing a whole Trace from one is the shortest path for credentials to leave the building.
- **A single-Step slice is also what a fixing agent actually needs.** The Handoff already carries the Flow context, the Step, and the Findings or Regressions; what it lacked was the page as it stood when the Step ran.
- **The slice is still sensitive**, just bounded enough to reason about. It inherits the `containsSecrets` accounting that gates any future upload adapter.
