# Runs are Chromium-only, deliberately

Contingency executes Flows in Chromium only. This was inherited rather than chosen — the bundled `agent-browser` supported nothing else — and [ADR 0012](./0012-playwright-is-the-in-process-browser-runtime.md) removes the constraint by making Firefox and WebKit available from the same API. It is kept anyway for now, and recorded here so it reads as a decision rather than an assumption.

## Consequences

- **The cost is specific and worth stating, because it is what makes this reversible.** Three capabilities are CDP-bound and therefore Chromium-only: Create View's screencast, Core Web Vitals collection ([ADR 0008](./0008-performance-is-a-navigation-step-toggle.md)), and any future use of Chrome's `Tracing` domain. Accessibility Audits have no such tie.
- **Cross-engine is a real product, not a flag flip.** Accessibility behaviour genuinely differs across browser and assistive-technology pairings, so "passes in Chromium, fails in WebKit" is exactly the kind of Finding Contingency exists to surface. Reaching it means Create View and performance measurement run on one engine while accessibility Runs span three, and Baseline comparison multiplies by engine — which touches [ADR 0009](./0009-run-execution-semantics.md).
- **The engine is not an Emulation field.** Emulation ([ADR 0013](./0013-emulation-belongs-to-the-flow.md)) describes the device and environment a Flow declares; the browser engine is a property of how a Run was invoked, and would belong with the other Run properties ([ADR 0014](./0014-artifacts-are-run-properties.md)) if it ever becomes selectable.
