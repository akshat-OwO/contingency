# A Run starts from a fresh context and ends quiescent

Each Run executes in a fresh Playwright browser context unless the Flow opts into persisted state, and after its final Step the Runner waits for the page to go quiet — network idle and DOM stability, bounded at roughly two seconds — before stopping capture and closing the context.

## Consequences

- **Re-running a Flow no longer accumulates state.** Storage mutations are live-only screwdriver operations ([ADR 0007](./0007-storage-mutations-are-live-only.md)), so a Flow that adds an item to a cart previously left it there: running twice yielded two items. `context.storageState()` gives a save and restore primitive `agent-browser` never offered, making isolation the default and persistence an explicit opt-in.
- **A Run no longer finishes mid-paint.** In the Run that motivated this, the final Step ended at `58.918` and the Run ended at `59.161` — 243ms later, closing the context while lazy content was still arriving. The last recorded frame showed a half-rendered page. That is not a video defect: an accessibility Audit or a Core Web Vitals measurement taken at that instant observes a page that has not finished existing.
- **This is not the Step pacing rejected in [ADR 0014](./0014-artifacts-are-run-properties.md).** The same quiescence primitive is applied once, at the end, rather than between every Step. No Step timing shifts and no measurement moves, so Regression comparison is unaffected; the Run simply stops tearing itself down early.
