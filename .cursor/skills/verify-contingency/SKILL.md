---
name: verify-contingency
description: Drive Contingency's local web UI and CLI the way a user does. Use when proving Create View, Audit View, Agent View, or `contingency run` behavior, capturing screenshots or ARIA snapshots, or checking a UI change against the live app rather than unit tests.
---

# Verify Contingency

Contingency's primary user surface is the local web UI served by the CLI: Create View at `/`, Audit View at `/audit`, Agent View at `/agent`. `contingency run` is the headless CLI for the same Runner Audit View uses. `contingency mcp` is a separate process that owns Agent Sessions; an ordinary `web` instance cannot invent them.

This skill drives a disposable production build of that UI through Playwright. It does not drive the user's existing `localhost:5173` or `127.0.0.1:7777` session.

Read `features/README.md`, then the feature file for the behavior under test, before opening the app. For the canonical product proof, start with `features/ecommerce-drive.md`.

Helper: `.cursor/skills/verify-contingency/bin/control-contingency` (executable). Examples below assume it is on `PATH` or invoked by that path. Evidence lands in `.cursor/skills/verify-contingency/artifacts/` and survives cleanup.

To change recipes, fixtures, or harness behavior, follow `.cursor/skills/maintain-verification-skill/SKILL.md`.

## Launch

Build once if `packages/cli/dist/index.js` or `packages/cli/dist/web/index.html` is missing:

```sh
nub exec turbo run build --filter=@contingency/cli
```

Start an isolated instance. Do not set `CONTINGENCY_WEB_PORT` to 7777 unless `lsof` shows that port free and you created it for this run.

```sh
CONTROL=".cursor/skills/verify-contingency/bin/control-contingency"
"$CONTROL" launch
```

Optional: `"$CONTROL" launch --flow /abs/path/to/flow.json` loads that Flow so Audit View is not empty.

Ready when stdout prints `CONTINGENCY_VERIFY_DIR=...` and `url=http://127.0.0.1:<port>/`, and `GET` of that URL returns 200 with `<title>Contingency</title>`. Export the printed directory for every later command:

```sh
export CONTINGENCY_VERIFY_DIR=...
```

Chromium for the driver (and for Create sessions / Runs) comes from `playwright-core` in `packages/cli`. If launch fails on the driver, install it with `nub exec --cwd packages/cli playwright-core install chromium` and retry.

Default developer `nub exec contingency web` is a different mode: Vite on 5173 plus CLI on 7777, and it opens a real browser. Verification never uses that pair. It runs `NODE_ENV=production node packages/cli/dist/index.js web --no-browser` on a private port with `CONTINGENCY_STATE_DIR` under the verify directory.

## Doctor

Run this first whenever anything looks off, and after launch before driving.

```sh
"$CONTROL" doctor
```

Done when stdout is JSON with `"ok": true` and the `pid`, `port`, `url`, and `stateDir` match the instance you launched. Fail and stop if the listening pid is not that instance, the page has no `Contingency` title, or the driver websocket is dead. Do not fall back to whatever is bound to 7777 or 5173.

## Ecommerce fixture

Start the local shop before Create or Audit drives that need a real site:

```sh
"$CONTROL" ecommerce start
```

Stdout prints `ecommerce=http://127.0.0.1:<port>/shop.html` (and `fixture=` with the same URL). Export it:

```sh
export ECOMMERCE_URL=...
```

`fixture start` is an alias. Pages live under `.cursor/skills/verify-contingency/fixtures/ecommerce/`.

## Drive

Commands are literal. Prefer the feature file's `--role` / `--name` pairs.

```sh
"$CONTROL" browser goto --path /
"$CONTROL" browser wait --role link --name Create
"$CONTROL" browser click --role link --name Audit
"$CONTROL" browser fill --role textbox --name "Flow title" --value "Pharmacy"
"$CONTROL" browser set-input-files --label "Open a Flow file" --path "$CONTINGENCY_VERIFY_DIR/recorded-flow.json"
"$CONTROL" browser download --role button --name ".json" --partial --path ecommerce-drive/recorded-flow.json
"$CONTROL" browser snapshot --aria --path create-view/create.aria.txt
"$CONTROL" browser screenshot --path create-view/create.png
"$CONTROL" cli -- run "$CONTINGENCY_VERIFY_DIR/verify-flow.json" --retry 0 --output "$CONTINGENCY_VERIFY_DIR/state/runs"
```

### Two surfaces in Create View

| Surface | Drive with |
| --- | --- |
| Contingency chrome (nav, session picker, address bar, authoring panel, Recording controls) | `control-contingency browser` |
| Nested ecommerce site inside the workspace canvas | `computerUse` subagent at the verification URL |

Do not click the canvas through `control-contingency browser` as if it were the nested page DOM.

Stable handles in this repo:

- Primary nav: `link` named `Contingency`, `Create`, `Audit`, `Agent`. Current view sets `aria-current="page"` on that link.
- Create View: region `Browser workspace`, group `Browser navigation`, textbox `Browser address`, combobox `Choose browser session`, complementary/heading `Flow authoring`, textbox `Flow title`, button `Start Recording` (disabled until a session, URL, and title are set), text `No Recording yet`, heading `Your browser will appear here` before a session exists.
- Audit View with no Flow: heading `No Flow to audit`, label `Open a Flow file`.
- Audit View with a Flow: heading is the Flow title, button `Run Flow` (then `Run again`), status `Not started` / `Starting` / `Running` / `Completed` / `Failed`.
- Audit View after a Run: region `Derived frames`, button `Play`, slider `Scrub the derived frames`, buttons `Previous Step` / `Next Step`, frame pins `Step N` / `Run settled`.
- Agent View on `web` (no MCP): destructive `alert` titled `Agent Session unavailable` and text `Agent Sessions are unavailable in this server process.` Use `browser wait --role alert --has-text "Agent Session unavailable"`.
- Agent View on `mcp` with no session: heading `No active Agent Sessions`.
- Agent View with a live session: heading `Agent View`, canvas `Live browser viewport` (`aria-readonly` follows control), group `Browser navigation` with buttons `Go back` / `Go forward` / `Reload page`, textbox `Browser address`, combobox `Agent Session`, list `Action timeline`, and one control button that reads `Take control` or `Return control`.
- Agent View with a Teaching session: region and heading `Teaching` with terms `Captured actions` and `Instructions`, an alert `Draft saved: <title>` once `agent_flow_draft_save` succeeds, and the Teaching Feed disclosure paragraph. Absent for an Interactive Run.

`contingency mcp` binds `127.0.0.1` only (`CONTINGENCY_MCP_PORT`, default 7777) and prints `Contingency MCP Agent View available at http://127.0.0.1:<port>/agent` on stderr. This verification launch path does not start MCP. To prove a live Agent Session you must start `mcp` in its own isolated port and state dir; do not attach to an MCP process you did not start.

`mcp start` runs that server under a broker that holds one MCP stdio conversation open, so `mcp call --tool <name> --params <json>` reaches the same process that serves Agent View. That is the only way a drive can create an Agent Session: sessions live inside their owning process. A tool refusal prints its reason and exits `2`.

`mcp start` also sets `CONTINGENCY_CATALOG_ROOT` to `$CONTINGENCY_VERIFY_DIR/state/catalog`, so drafts saved with `agent_flow_draft_save` land in the isolated state rather than the repository's `.contingency`. `cleanup` removes them with the rest of that state.

## Evidence

Put proof under `.cursor/skills/verify-contingency/artifacts/<feature-id>/`. Relative `--path` values are resolved there.

A proof is incomplete unless it includes:

- The user action (command plus handle), not an RPC or test helper that skips the UI.
- The resulting state (ARIA snapshot and screenshot for UI; stdout, stderr, exit code, and `run.json` path for CLI).
- A second observation for mutations: reopen the view or read the written Run directory under `$CONTINGENCY_VERIFY_DIR/state/runs`.
- The feature id and entry point used.

Traces and Run videos are sensitive. Verification Runs may write them under the isolated state dir; do not copy them into `artifacts/` unless the feature file asks, and never reuse the user's default `~/.local/state/contingency`.

Mocks are not allowed for the Runner, Playwright, or the web UI. The ecommerce HTTP server (`control-contingency ecommerce start`) is verification scaffolding. Cleanup removes that server.

## Cleanup

```sh
"$CONTROL" cleanup
```

This signals only the pids recorded in `$CONTINGENCY_VERIFY_DIR/instance.json` (CLI server, driver browser, fixture, MCP). It deletes the instance file, browser profile, and isolated state dir. It does not delete `.cursor/skills/verify-contingency/artifacts/`. After cleanup, confirm those artifact files still exist.

If launch failed partway, still run cleanup with `CONTINGENCY_VERIFY_DIR` pointing at the directory launch printed, so ports are not left bound.

## Helpers

```sh
CONTROL=".cursor/skills/verify-contingency/bin/control-contingency"
"$CONTROL" launch
export CONTINGENCY_VERIFY_DIR=...   # from launch stdout
"$CONTROL" doctor
"$CONTROL" ecommerce start
export ECOMMERCE_URL=...            # from ecommerce stdout
"$CONTROL" browser goto --path /audit
"$CONTROL" browser goto --url http://127.0.0.1:<mcp-port>/agent
"$CONTROL" browser wait --role alert --has-text "Agent Session unavailable"
"$CONTROL" mcp start
"$CONTROL" mcp call --tool agent_sessions_get
"$CONTROL" mcp stop
"$CONTROL" fixture start            # alias for ecommerce start
"$CONTROL" reload --flow "$CONTINGENCY_VERIFY_DIR/verify-flow.json"
"$CONTROL" cli -- run "$CONTINGENCY_VERIFY_DIR/verify-flow.json" --retry 0
"$CONTROL" cleanup
```

`launch` refuses if that verify dir already has a live pid. Two verification instances may run side by side because each picks its own port and `CONTINGENCY_STATE_DIR`. They must not share 7777, 5173, or the user's real state directory.
