# Runner timeouts are set explicitly, not inherited

> Superseded by [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) for new work: this decision belongs to the removed deterministic Flow and Audit View stack.

The Runner sets Playwright's `actionTimeout` and `navigationTimeout` explicitly and drops the timeouts that existed to work around the previous browser tool's subprocess queue.

## Consequences

- **`FLUSH_TIMEOUT`, `CLOSE_TIMEOUT`, and `STOP_LOADING_TIMEOUT` go.** Each was calibrated against `agent-browser` running one command at a time per session — the flush bound exists explicitly because "a command is still in flight" — and that queue does not survive [ADR 0012](./0012-playwright-is-the-in-process-browser-runtime.md). Keeping numbers whose justification was deleted is cargo.
- **Playwright's 30-second default is never inherited silently.** Under [ADR 0009](./0009-run-execution-semantics.md)'s `--retry 3` and five-minute Run ceiling, a handful of 30-second actions consume the whole budget and the Run reports a ceiling breach rather than the Step that actually hung.
- **The Run's wall-clock ceiling stays**, for the reason ADR 0009 gives: per-Step timeouts do not bound a long Flow under retry.
- **Per-Step override already exists** — `Step.timeout` is in the Flow schema — and continues to win over the configured default.
