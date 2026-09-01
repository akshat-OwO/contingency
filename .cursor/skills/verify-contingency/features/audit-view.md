# Audit View

Audit View runs one Flow at a time. With no Flow it explains how to load one. With a Flow it shows the title and `Run Flow`, then live phase and a finished outcome.

## Sub-features

- `audit-empty` shows `No Flow to audit` when the process was started without a Flow.
- `audit-nav` reaches that view from primary navigation.
- `audit-loaded` shows the Flow title and `Run Flow` when launch used `--flow`.
- `audit-run` starts a Run and reaches a terminal phase of `Completed` or `Failed`.

## How to get to it (user POV)

- Choose the `Audit` link in primary navigation.
- Open `/audit` directly.
- Start the CLI as `contingency web <flow>` so Audit View already has that Flow.

## Driving it with control-contingency

Preconditions:

- Contingency is healthy at the verification URL.
- For `audit-empty` and `audit-nav`, launch had no `--flow`.
- For `audit-loaded` and `audit-run`, run `fixture start`, then `reload --flow "$CONTINGENCY_VERIFY_DIR/verify-flow.json"` on the same verify instance so the Flow points at the live fixture URL. Alternatively relaunch with `--flow` only after `fixture start` on a fresh instance where the fixture is started again before `Run Flow`.

- **Empty state.** Open Audit View with no Flow. Run `control-contingency browser goto --path /audit`. The heading `No Flow to audit` is visible and the copy tells the user to pass a Flow to `contingency web` or open a file. The control `Open a Flow file` is visible.
- **Nav entry.** From Create View choose Audit. Run `control-contingency browser goto --path /`, then `control-contingency browser click --role link --name Audit`. The `Audit` link is current and the empty heading is visible.
- **Loaded Flow.** With the fixture serving, load it into Audit View on the same instance. Run `control-contingency fixture start`, then `control-contingency reload --flow "$CONTINGENCY_VERIFY_DIR/verify-flow.json"`, then `control-contingency browser goto --path /audit`. The heading is `Verify fixture` and the button `Run Flow` is enabled. Status is `Not started` / `No Run yet`.
- **Start Run.** Choose `Run Flow`. Run `control-contingency browser click --role button --name "Run Flow"`. Phase becomes `Starting` or `Running`, then `Completed` or `Failed`. Wait with `control-contingency browser wait --role button --name "Run again" --timeout-ms 60000`. The nested site is the fixture `Verify fixture` page, not a mock inside the UI.
- **Proof (empty).** Snapshot the empty Audit View. Run `control-contingency browser snapshot --aria --path audit-view/empty.aria.txt` and `control-contingency browser screenshot --path audit-view/empty.png`. Both show Contingency, current `Audit`, and `No Flow to audit`.
- **Proof (run).** After `Run again` is visible, snapshot Audit View and read `$CONTINGENCY_VERIFY_DIR/state/runs/**/run.json`. The UI outcome and `run.json` `outcome` agree. Artifact paths: `audit-view/run.aria.txt`, `audit-view/run.png`.

## Gotchas

- File picker `Open a Flow file` is a real `<input type="file">` on the empty state. The loaded header uses `Open a Flow`. The driver has no `setInputFiles` wrapper yet. Prefer `launch --flow` over trying to automate the hidden file input.
- `Run Flow` against a public URL is not isolated. Use `fixture start` so the Flow navigates to `127.0.0.1` on a port this run owns. If you `cleanup` between `fixture start` and Audit, the fixture dies while the Flow file still references its old URL; prefer `reload --flow` on the same instance or start the fixture again before driving `Run Flow`.
- A Gate breach completes the Run and still shows `Completed`, with a separate `Gate breached` badge. Do not treat a breach as a failed Run.
- Reloading the SPA does not keep a Flow that was uploaded from the browser after launch. Process-argument Flows are the ones that survive a driver `goto`.
