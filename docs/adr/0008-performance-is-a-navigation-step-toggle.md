# Performance is a navigation Step toggle, not an Audit

Performance is measured by toggling `contingency.performance` on a Step that navigates — a `navigate` Step, or a `click` Step carrying an `assertedEvents` navigation. The Runner collects Core Web Vitals for that navigation using the browser's own `vitals` capability. This supersedes the performance half of [ADR 0005](./0005-audits-are-ordered-custom-steps.md): **Audit** now means accessibility only, and `AuditKind` collapses to a single literal.

Core Web Vitals are the product promise, and an ordered Audit Step cannot deliver them: a check placed at an arbitrary point mid-Flow either measures nothing time-based or has to re-navigate and destroy the state that made the page reachable. Attaching the measurement to a navigation the Flow already performs avoids both.

## Considered Options

- **Snapshot-style Audit Step** — correct at any Step position, but no timing metrics, so not Core Web Vitals.
- **Cold-navigation Audit Step** — full metrics, but re-navigates and discards Flow state; on an authenticated page it measures a user who does not exist.
- **Lighthouse navigation mode on toggled Steps** — full lab metrics and cross-machine comparability via simulated throttling, at the cost of an external engine that must own the navigation, plus a storage-reset default that logs the Flow out mid-Run.
- **Browser-native `vitals` on toggled Steps (chosen)** — LCP, CLS, TTFB, FCP, and INP measured in place, no separate navigation, no new engine, same interface as every other browser capability.

## Consequences

- Core Web Vitals are **warm-cache, logged-in** numbers. Contingency measures the page as a returning authenticated user experiences it.
- Measurement is unthrottled, so numbers reflect the host machine. **A Flow's Runs are comparable only within a machine class** — a Baseline recorded on a developer laptop and compared against a busy CI runner will read as a Regression caused by hardware. Regression logic must account for this, and the Run artifact must record enough about the environment to detect the mismatch.
- INP and CLS are available, which a cold lab navigation approximates poorly. Interaction responsiveness is measurable on the Steps that actually interact.
- Click-induced navigations are measured the same way as direct ones; nothing needs to own or re-issue the navigation.
- `performance: true` on a Step that cannot navigate is malformed and is rejected by the `Flow` schema, not silently ignored.
- Navigations Contingency does not model as Steps (redirects, client-side route changes) are not measured.
- Audits remain ordered custom Steps for accessibility, and everything in ADR 0005 other than the performance kind still holds.
- If cross-machine comparability later becomes a requirement, a throttled lab engine can be added behind a new seam without changing where the toggle lives.
