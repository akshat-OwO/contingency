# CLI owns the sole Runner

Executing a Flow into a **Run** happens only in the Contingency CLI Runner. The Audit View (headed) and headless CLI invocations are adapters over that engine; the web UI does not embed a second player that must be kept in sync. Create View's live browser session is for authoring (Recording), not for producing Runs.

## Consequences

- Audit View must invoke or attach to the CLI Runner to watch a Run in realtime.
- Headless CI/cron and interactive Audit View share one execution path, Findings shape, and Baseline comparison logic.
- Protocol RPCs that stream a browser for Create View remain separate from Run execution until the Runner reuses the same browser stack deliberately.
