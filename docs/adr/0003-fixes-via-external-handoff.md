# Fixes go through an external Handoff

Contingency detects Findings and Regressions and can emit **Alerts** and a structured **Handoff** (Flow context, Step, Findings/Regressions) for an external agent to attempt a fix. Contingency does not ship or run the customer's fixing agent. This keeps the product boundary at monitor-and-describe, avoids owning each customer's repo/tooling, and lets companies plug in their own agents.
