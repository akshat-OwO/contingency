# Recording follows Pages, and captures hover by gesture

> Superseded by [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) for new work: this decision belongs to the removed deterministic Flow and Audit View stack. Amends [ADR 0006](./0006-incomplete-recordings-recover-from-checkpoints.md).

A Recording follows a popup or additional tab as a new Page instead of failing on it, and captures the two continuous new actions differently: `hover` only when the author asks for it, `scroll` automatically at each resting position.

## Consequences

- **"An unsupported additional tab or popup" leaves ADR 0006's terminal-failure list.** That entry described a missing capability, not lost integrity — the recorder detects a popup opened by its pinned target specifically in order to fail on it. Playwright's `context.on('page')` supplies what was missing, and [ADR 0011](./0011-flow-is-a-native-format.md) gives Steps a Page to name. The rest of the list is unchanged and still terminal: navigation while paused, a closed pinned session, an unaddressable selector, event-limit or sequence overflow, and malformed page-derived recorder data. Those are genuine integrity failures.
- **The pinned-session rule survives, widened to the context.** Recovery still cannot migrate a Recording to another browser session; it can now span Pages within one.
- **`hover` is captured by explicit author gesture**, matching how Pre-steps are authored. Every mouse move is a hover, so dwell-and-reveal heuristics would produce junk Steps at volume — and a hover that matters is nearly always revealing a menu, which the author recognises far more reliably than a threshold does.
- **`scroll` is captured automatically, coalesced to one Step per resting position.** Unlike hover it is continuous and unremarkable, so requiring annotation would be a tax on every Recording. Coalescing is what makes it one meaningful Step rather than a wheel-tick log.
- **Both matter to Audits, not just to Replay.** Lazy-loaded content that is never scrolled to, and a menu that is never opened, are invisible to an accessibility Audit — which is the reason these actions exist ([ADR 0011](./0011-flow-is-a-native-format.md)).
