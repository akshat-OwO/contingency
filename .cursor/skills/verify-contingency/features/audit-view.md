# Audit View

Audit View runs one Flow at a time. With no Flow it explains how to load one. With a Flow it shows the title and `Run Flow`, then live phase and a finished outcome.

## Sub-features

- `audit-empty` shows `No Flow to audit` when the process was started without a Flow.
- `audit-nav` reaches that view from primary navigation.
- `audit-loaded` shows the Flow title and `Run Flow` when launch used `--flow`.
- `audit-run` starts a Run and reaches a terminal phase of `Completed` or `Failed`.
- `audit-open-file` loads a Flow through `Open a Flow file` on the empty state.
- `audit-video` scrubs derived frames and plays the Run video after a completed Run.

## How to get to it (user POV)

- Choose the `Audit` link in primary navigation.
- Open `/audit` directly.
- Start the CLI as `contingency web <flow>` so Audit View already has that Flow.

## Driving it with control-contingency

Preconditions:

- Contingency is healthy at the verification URL.
- For `audit-empty` and `audit-nav`, launch had no `--flow`.
- For `audit-loaded` and `audit-run` with the smoke Flow, run `ecommerce start`, then `reload --flow "$CONTINGENCY_VERIFY_DIR/verify-flow.json"`. For a recorded cart Flow, use `browser set-input-files` (see below).

- **Empty state.** Open Audit View with no Flow. Run `control-contingency browser goto --path /audit`. The heading `No Flow to audit` is visible and the copy tells the user to pass a Flow to `contingency web` or open a file. The control `Open a Flow file` is visible.
- **Nav entry.** From Create View choose Audit. Run `control-contingency browser goto --path /`, then `control-contingency browser click --role link --name Audit`. The `Audit` link is current and the empty heading is visible.
- **Loaded Flow (smoke).** With ecommerce serving, load the smoke Flow. Run `control-contingency ecommerce start`, then `control-contingency reload --flow "$CONTINGENCY_VERIFY_DIR/verify-flow.json"`, then `control-contingency browser goto --path /audit`. The heading is `Contingency Shop smoke` and the button `Run Flow` is enabled. Status is `Not started` / `No Run yet`.
- **Open recorded Flow.** On the empty Audit View, run `control-contingency browser set-input-files --label "Open a Flow file" --path "$CONTINGENCY_VERIFY_DIR/recorded-flow.json"`. The heading matches the recorded Flow title and `Run Flow` is enabled.
- **Start Run.** Choose `Run Flow`. Run `control-contingency browser click --role button --name "Run Flow"`. Phase becomes `Starting` or `Running`, then `Completed` or `Failed`. Wait with `control-contingency browser wait --role button --name "Run again" --timeout-ms 120000`.
- **Proof (empty).** Snapshot the empty Audit View. Run `control-contingency browser snapshot --aria --path audit-view/empty.aria.txt` and `control-contingency browser screenshot --path audit-view/empty.png`. Both show Contingency, current `Audit`, and `No Flow to audit`.
- **Proof (run).** After `Run again` is visible, snapshot Audit View and read `$CONTINGENCY_VERIFY_DIR/state/runs/**/run.json`. The UI outcome and `run.json` `outcome` agree. Artifact paths: `audit-view/run.aria.txt`, `audit-view/run.png`.
- **Scrub and play.** After a completed Run, click a Step in the timeline, move the `Scrub the derived frames` slider, click `Play`, then `Pause`. Use `Next Step` / `Previous Step` when enabled. Capture `audit-view/video.aria.txt` and `video.png`.

## Gotchas

- File picker `Open a Flow file` is a real `<input type="file">` on the empty state. Use `control-contingency browser set-input-files --label "Open a Flow file" --path <flow.json>`. The loaded header uses `Open a Flow` to replace the current Flow.
- `Run Flow` against a public URL is not isolated. Use `ecommerce start` so the Flow navigates to `127.0.0.1` on a port this run owns. If you `cleanup` between `ecommerce start` and Audit, the server dies while the Flow file still references its old URL; keep ecommerce running or restart it before driving `Run Flow`.
- A Gate breach completes the Run and still shows `Completed`, with a separate `Gate breached` badge. Do not treat a breach as a failed Run.
- Reloading the SPA does not keep a Flow that was uploaded from the browser after launch. Process-argument Flows are the ones that survive a driver `goto`.
- For the full recorded-Flow path (open file → run → scrub video), follow `ecommerce-drive.md`.
