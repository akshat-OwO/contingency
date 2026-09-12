# Performance is a navigation Step toggle, not an Audit

> Superseded by [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) for new work: this decision belongs to the removed deterministic Flow and Audit View stack.

Performance is measured by toggling `contingency.performance` on a Step that navigates — a `navigate` Step, or a `click` Step carrying an `assertedEvents` navigation. The Runner collects Core Web Vitals for that navigation from the page the Flow already loaded. This supersedes the performance half of [ADR 0005](./0005-audits-are-ordered-custom-steps.md): **Audit** now means accessibility only, and `AuditKind` collapses to a single literal.

Core Web Vitals are the product promise, and an ordered Audit Step cannot deliver them: a check placed at an arbitrary point mid-Flow either measures nothing time-based or has to re-navigate and destroy the state that made the page reachable. Attaching the measurement to a navigation the Flow already performs avoids both.

## Considered Options

- **Snapshot-style Audit Step** — correct at any Step position, but no timing metrics, so not Core Web Vitals.
- **Cold-navigation Audit Step** — full metrics, but re-navigates and discards Flow state; on an authenticated page it measures a user who does not exist.
- **Lighthouse navigation mode on toggled Steps** — full lab metrics and cross-machine comparability via simulated throttling, at the cost of an external engine that must own the navigation, plus a storage-reset default that logs the Flow out mid-Run.
- **Browser-native `vitals` on toggled Steps** — chosen originally, then found not to do what this decision requires. Verified against the bundled binary: `vitals` reloads the page. `navigationType` goes from `navigate` to `reload` and everything the Flow built up in the page is destroyed, which is the cold-navigation option above wearing a different name.
- **Recording the page's own performance timeline from the start of each navigation (chosen)** — LCP, CLS, TTFB, FCP, and INP measured in place, no separate navigation, no new engine. A page init script arms the observers before any page script runs, and the Runner reads what they collected. Reading after the fact is not enough: verified against the bundled binary, an observer registered after an interaction sees nothing for it, so a responsive page reported no INP at all.

## Consequences

- Core Web Vitals are **warm-cache, logged-in** numbers. Contingency measures the page as a returning authenticated user experiences it.
- Measurement is unthrottled, so numbers reflect the host machine. **A Flow's Runs are comparable only within a machine class** — a Baseline recorded on a developer laptop and compared against a busy CI runner will read as a Regression caused by hardware. Regression logic must account for this, and the Run artifact must record enough about the environment to detect the mismatch.
- INP and CLS are available, which a cold lab navigation approximates poorly. Interaction responsiveness is measurable on the Steps that actually interact.
- **Measurement happens at the last moment the Run is on the page** — just before navigating away, or when the attempt ends — rather than the instant the navigation finishes. CLS and LCP keep accruing after load, and a page nobody has interacted with yet has no INP at all, so sampling at the navigation would record the metric as permanently absent.
- A metric the page did not produce is recorded as absent, never as zero, so the fastest possible page stays distinguishable from an unmeasured one.
- **A headless Run that is not being captured often reports no paint at all.** The browser paints when it has reason to, and a Run that navigates and works through Steps does not always give it one: measuring a fixed local page ten times per condition for [issue #25](https://github.com/akshat-OwO/contingency/issues/25), uncaptured Runs reported no FCP, LCP or INP in 7 of 10 on one pass, and in 1, 2 and 4 of 10 on others, while every captured Run reported all three, because a capture forces frames. Load average was the same either way. The absence is recorded honestly rather than guessed at, so nothing reports a wrong number, but a Flow that wants dependable paint metrics from a headless Run cannot yet rely on getting them. Closing that gap is its own work; what this ADR records is that the gap exists and how it was measured. An interaction too fast to be reported as an `event` entry still yields an INP, for the same reason.
- **A Run that might measure anything has to arm the recorder when it opens its session**, before the first navigation. A session that did not cannot be measured retroactively.
- CLS is the worst session window rather than the sum of every shift, so two unrelated shifts seconds apart do not report a page as twice as unstable as it is.
- A measurement that cannot be taken does not fail the Step. The navigation happened and the page is there; failing the Run over a metric read would report a broken site on the strength of the Runner's own inability to observe it. The absence is reported instead.
- Click-induced navigations are measured the same way as direct ones; nothing needs to own or re-issue the navigation.
- `performance: true` on a Step that cannot navigate is malformed and is rejected by the `Flow` schema, not silently ignored.
- Navigations Contingency does not model as Steps (redirects, client-side route changes) are not measured.
- Audits remain ordered custom Steps for accessibility, and everything in ADR 0005 other than the performance kind still holds.
- If cross-machine comparability later becomes a requirement, a throttled lab engine can be added behind a new seam without changing where the toggle lives.
