# Headless Run

`contingency run` executes a Flow with the same Runner Audit View uses, without opening the web UI. It prints the Run id, outcome, and artifact directory, and exits `0` on a completed Run that did not breach its Gate, `1` if the Run did not complete, and `2` if it completed and breached its Gate.

## Sub-features

- `run-complete` finishes a one-step navigate Flow against the local ecommerce shop home page.
- `run-directory` writes artifacts under the isolated state directory, not the user's default state home.
- `run-report` prints `Run <id> <outcome>` and the directory path.

## How to get to it (user POV)

- Run `contingency run <flow.json>` in a terminal.
- From this helper, `control-contingency cli -- run <flow.json> ...`.

## Driving it with control-contingency

Preconditions:

- `packages/cli/dist/index.js` exists.
- `CONTINGENCY_VERIFY_DIR` is set. `launch` is optional; `cli` will use `$CONTINGENCY_VERIFY_DIR/state` either way.
- `control-contingency ecommerce start` has printed `flow=` pointing at `$CONTINGENCY_VERIFY_DIR/verify-flow.json` and `ecommerce=` at `/shop.html`.
- Chromium for `playwright-core` is installed.

- **Start ecommerce.** Serve the shop. Run `control-contingency ecommerce start`. Stdout contains `ecommerce=http://127.0.0.1:` ending in `/shop.html` and `flow=` ending in `verify-flow.json`.
- **Run Flow.** Execute it headlessly with retries off. Run `control-contingency cli -- run "$CONTINGENCY_VERIFY_DIR/verify-flow.json" --retry 0 --output "$CONTINGENCY_VERIFY_DIR/state/runs"`. Exit code `0`. Stdout contains `Run ` and `completed` or `failed`, then a directory under `$CONTINGENCY_VERIFY_DIR/state/runs`.
- **Confirm artifacts.** Read `run.json` in that directory. `flow.title` is `Contingency Shop smoke` and `outcome` matches the printed line. The directory is not under `~/.local/state/contingency`.
- **Proof.** Copy the CLI transcript (command, stdout, stderr, exit code) to `cli-run/run.txt` and copy `run.json` to `cli-run/run.json`. Keep traces in the isolated state dir; do not copy Trace zips into `artifacts/` unless you are proving Trace retention itself.

## Gotchas

- Exit `2` is a completed Run that breached its Gate. The site missed the bar; the Run is still a Baseline. Do not describe that as a crash.
- `--retry 0` is required for Flows with real side effects. The fixture page is read-only, but keeping retry off makes a failure show up instead of being hidden by a second attempt.
- `cli` sets `CONTINGENCY_STATE_DIR` from the verify instance. If you invoke `node packages/cli/dist/index.js run` yourself and forget that variable, artifacts land in the user's real state directory.
- The ecommerce process is recorded on `instance.json`. `cleanup` kills it. `ecommerce stop` / `fixture stop` kills it and leaves the CLI running.
