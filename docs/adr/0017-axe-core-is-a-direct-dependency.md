# axe-core is a direct dependency, pinned by Contingency

Accessibility Audits run `axe-core` through `@axe-core/playwright` against the page, replacing the `a11y --json` subprocess that disappears with the bundled binary ([ADR 0012](./0012-playwright-is-the-in-process-browser-runtime.md)). This is forced work, not opportunistic: the engine was always axe — the nested `target` paths the Runner already decodes are axe's own format — but it arrived through a tool that pinned it on Contingency's behalf.

## Considered Options

- **Inject `axe-core` directly** via `addInitScript` and drive frames by hand. Genuinely available, since the recorder already owns frame machinery, but the wrapper's whole value is cross-frame injection and target-path stitching — the part worth getting wrong least.

## Consequences

- **Contingency pins the engine version, which it could not before.** `flow.ts` already pins rule _tags_ with the reasoning that "an engine upgrade otherwise introduces new rules silently, and on the day of the upgrade every one of them looks like a Regression" — and then left the engine itself to whatever `agent-browser` 0.33.2 bundled. A direct dependency closes that.
- **The axe version is recorded in `RunEnvironment` and a mismatch warns.** `RunEnvironment` already records the machine because unthrottled Core Web Vitals depend on it ([ADR 0008](./0008-performance-is-a-navigation-step-toggle.md)); comparing against a Baseline built by a different engine attributes rule churn to the site. It warns rather than refuses, matching how [ADR 0010](./0010-run-video-is-unredacted.md) handles a recorded-versus-unrecorded comparison. The lockfile is not sufficient — a Baseline outlives a dependency bump.
- **Node elision stays per-rule and the cap becomes Contingency's own.** `nodeCount` continues to report what the page actually has while `nodes` carries a bounded sample, so a rule failing on four hundred elements says so without producing four hundred Findings. Regression comparison works off `nodeCount` moving. The cap was previously the browser tool's and unstated; it is now chosen and written down.
- **The guard against a rule set that selects nothing is kept.** An unrecognised tag is not an error to axe: it selects no rules and every page audits clean, which reads as a passing Audit forever. An Audit that evaluated nothing at all remains a failure.
- **Surfacing axe's `incomplete` bucket is deferred.** Incomplete results — "needs review", most often colour contrast over a background image — are addressable and therefore arguably Findings, but they are engine-uncertain rather than site-wrong and would need a new field on `Finding` to say so. They stay counted and unsurfaced, as today. If they are surfaced later they must never trip a Gate ([ADR 0018](./0018-a-gate-fails-the-exit-code-not-the-run.md)), because failing a build on undecidable results is the failure mode [ADR 0009](./0009-run-execution-semantics.md) exists to prevent.
