# Fixes go through an external Handoff

> Superseded by [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) for new work: this decision belongs to the removed deterministic Flow and Audit View stack. Amended by [ADR 0020](./0020-a-handoff-carries-a-step-slice-not-a-trace.md): a Handoff may carry the failing Step's snapshot slice, never a whole Trace.

Contingency detects Findings and Regressions and can emit **Alerts** and a structured **Handoff** (Flow context, Step, Findings/Regressions) for an external agent to attempt a fix. Contingency does not ship or run the customer's fixing agent. This keeps the product boundary at monitor-and-describe, avoids owning each customer's repo/tooling, and lets companies plug in their own agents.
