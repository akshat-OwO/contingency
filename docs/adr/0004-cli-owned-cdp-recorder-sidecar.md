# CLI owns a CDP recorder sidecar

> Superseded by [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) for new work: this decision belongs to the removed deterministic Flow and Audit View stack. Superseded by [ADR 0012](./0012-playwright-is-the-in-process-browser-runtime.md). The recorder's design survives; the transport beneath it does not.

Create View recordings are captured by a CLI-owned CDP sidecar that connects through the browser endpoint exposed by `agent-browser`. The sidecar injects bundled recorder code into restricted isolated worlds across browser frames and emits validated semantic actions; CDP is never exposed to the web UI. This revises the earlier assumption that all CDP access stays inside `agent-browser`, because its public event stream cannot reliably supply the selectors, frame context, or navigation events required for Chrome Recorder–compatible Steps.

## Consequences

- The isolated worlds do not receive universal cross-origin access, and recorder messages are treated as untrusted, schema-validated, size-bounded data.
- Only trusted user events are captured. Sensitive values never leave the isolated recorder world; their Steps retain Secret Variable references instead.
- Cross-origin frames and open shadow roots are supported. Closed shadow roots are outside the supported recording boundary.
- During authoring, the same isolated recorder world may emit bounded hover metadata so Create View can outline the prospective target and show its tag, selected ARIA properties, and dimensions. This inspection signal is visual-only and never becomes a Step.
