# CLI owns the sole Runner

> Superseded by [ADR 0029](./0029-contingency-owns-the-sole-runner.md): the CLI and MCP server are now adapters over a Contingency-owned Runner.
>
> Amended by [ADR 0012](./0012-playwright-is-the-in-process-browser-runtime.md): the Runner and Create View now share one browser stack, which the last consequence below left open.

Executing a Flow into a **Run** happens only in the Contingency CLI Runner. The Audit View (headed) and headless CLI invocations are adapters over that engine; the web UI does not embed a second player that must be kept in sync. Create View's live browser session is for authoring (Recording), not for producing Runs.

## Consequences

- Audit View must invoke or attach to the CLI Runner to watch a Run in realtime.
- Headless CI/cron and interactive Audit View share one execution path, Findings shape, and Baseline comparison logic.
- Protocol RPCs that stream a browser for Create View remain separate from Run execution until the Runner reuses the same browser stack deliberately.
