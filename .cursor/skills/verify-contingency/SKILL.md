---
name: verify-contingency
description: Drive Contingency's local web UI and MCP server the way a user does. Use when proving Workspace, Teaching, or Run behavior, capturing screenshots or ARIA snapshots, or checking a UI change against the live app rather than unit tests.
---

# Verify Contingency

Contingency's local UI has one Workspace route at `/`. Teaching, Dry Runs, Interactive Runs, and persisted Run Summaries share it. Both `contingency web` and `contingency mcp` own Agent Sessions. Each process owns a separate live registry and reads Teaching Recordings from the shared Catalog Root.

This skill drives a disposable production build of that UI through Playwright. It does not drive the user's existing `localhost:5173` or `127.0.0.1:7777` session.

Read `features/README.md`, then the feature file for the behavior under test, before opening the app. For the canonical product proof, start with `features/workspace.md`.

Helper: `.cursor/skills/verify-contingency/bin/control-contingency` (executable). Examples below assume it is on `PATH` or invoked by that path. Evidence lands in `.cursor/skills/verify-contingency/artifacts/` and survives cleanup.

To change recipes, fixtures, or harness behavior, follow `.cursor/skills/maintain-verification-skill/SKILL.md`.

## Launch

Build once if `packages/cli/dist/index.js` or `packages/cli/dist/web/index.html` is missing:

```sh
nub exec turbo run build --filter=@contingencyhq/cli
```

Start an isolated instance. Do not set `CONTINGENCY_WEB_PORT` to 7777 unless `lsof` shows that port free and you created it for this run.

```sh
CONTROL=".cursor/skills/verify-contingency/bin/control-contingency"
"$CONTROL" launch
```

Ready when stdout prints `CONTINGENCY_VERIFY_DIR=...` and `url=http://127.0.0.1:<port>/`, and `GET` of that URL returns 200 with `<title>Contingency</title>`. Export the printed directory for every later command:

```sh
export CONTINGENCY_VERIFY_DIR=...
```

Chromium for the driver (and for Agent Sessions and Runs) comes from `playwright-core` in `packages/cli`. If launch fails on the driver, install it with `nub exec --cwd packages/cli playwright-core install chromium` and retry.

Default developer `nub exec contingency web` is a different mode: Vite on 5173 plus CLI on 7777, and it opens a real browser. Verification never uses that pair. It runs `NODE_ENV=production node packages/cli/dist/index.js web --no-browser` on a private port with `CONTINGENCY_CATALOG_ROOT` under the verify directory.

## Doctor

Run this first whenever anything looks off, and after launch before driving.

```sh
"$CONTROL" doctor
```

Done when stdout is JSON with `"ok": true` and the `pid`, `port`, `url`, and `stateDir` match the instance you launched. Fail and stop if the listening pid is not that instance, the page has no `Contingency` title, or the driver websocket is dead. Do not fall back to whatever is bound to 7777 or 5173.

## Ecommerce fixture

Start the local shop before Workspace drives that need a real site:

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
"$CONTROL" browser url
"$CONTROL" browser wait --role region --name "Workspace dock"
"$CONTROL" browser resize --width 390 --height 844
"$CONTROL" browser input-check --session-id <teaching-session-id>
"$CONTROL" browser snapshot --aria --path workspace/entry.aria.txt
"$CONTROL" browser screenshot --path workspace/entry.png
```

### Two surfaces in Workspace

| Surface | Drive with |
| --- | --- |
| Contingency chrome (nav, dock, session picker, address bar) | `control-contingency browser` |
| Nested ecommerce site inside the workspace canvas | `computerUse` subagent at the verification URL; `browser input-check` for the fixed rapid-input fixture |

Use `browser input-check` only on the dedicated `input-check.html` fixture. Other nested site actions still use `computerUse`.

Stable handles in this repo:

- Primary nav: `link` named `Contingency` and `Workspace`, with `aria-current="page"` on `/`. The header band is not unconditional: every Workspace that owns the viewport — the empty Workspace, a live Teaching session, a Dry Run, and an Interactive Run — is one floating dock over a full-bleed browser, so the wordmark moves into the dock and the header steps aside. A Run Summary and an unknown route keep the header.
- The dock is `region` named `Workspace dock`. It carries `Contingency`, the `Agent Session` combobox, the state badge, the next-step sentence, the secondary actions, and at most one primary action. There is no session status sidebar on any live session.
- Workspace on `web` or `mcp` with no session: heading `No browser session`, badge `No session` in the dock, and exactly one button named `Open browser session`, on the canvas. `contingency web` opens a Teaching session from it without MCP.
- An option in the `Agent Session` selector is the Flow Skill name and what the session does with it: `browse-catalogue`, `add-anvil · Dry Run`, `browse-catalogue · Interactive Run`. The state lives in the badge, and a raw session id is never a label.
- Inspect during `recording` is the button `Inspect an element and comment`. It outlines the live element, opens `Describe the change`, and `Attach` records a Teaching instruction. `Start recording`, `Stop recording`, `Open browser session`, and the inspect toggle all have distinct accessible names.
- Workspace with a live session: region `Workspace dock`, canvas `Live browser viewport` (`aria-readonly` follows control), group `Browser navigation` with buttons `Go back` / `Go forward` / `Reload page`, textbox `Browser address`, combobox `Agent Session`. There is no `Workspace` heading and no `Action timeline` list. A Dry Run and an Interactive Run each have exactly one control button that reads `Take control` or `Return control`; a Teaching session has neither. The canvas and toolbar are the user's from the start. Teaching private Variables enter only through the Workspace loopback `agent.teaching.variable.input`; Workspace has no private-value button or dialog.
- A live Interactive Run's dock names the Flow Skill and reads `Agent Step <n> of <total>.` in its sentence. Coverage is a button whose accessible name is `<executed> of <total> Agent Steps executed. Agent Step <n> of <total>.`; opening it shows that Step's name and its `Done when:` line. The Step name and `Done when:` line are never in the dock row itself (#238). It offers `Extend Agent Step ceiling` and `Extend Run ceiling` until the Run ends; those buttons are the only way either ceiling grows. A live Dry Run's dock reads `Rehearsing the flow skill <name>.` and names its changed inputs.
- Workspace with a live Teaching session: the dock's badge and next-step sentence carry the capture state. Stop makes the process-independent Teaching Recording available to the Flow Skill learning tools while the browser remains open, without closing the Agent Session. Prove the recording lifecycle and the saved Flow Skill through MCP and the isolated Catalog Root.
- Interactive Runs show missing runtime Variables in the read-only `Runtime Variables` region. A Dry Run shows its secret Variables in `Dry Run secrets`; the user supplies a value there while the agent sees only the name and supply status.
- A finished Interactive Run's Summary lists each assessed Step's outcome, explanation, and Snapshot or attempt references beside the recorded video. A finished Dry Run shows the same Summary in the Teaching Workspace beside **Verify flow** and **Reject flow**, or beside its failed state.
- A saved `SKILL.md` carries Contingency-stamped `hosts` and `emulation` frontmatter beside the agent's `name`, `description`, and `inputs`. A Run refuses a start URL outside those hosts and reopens the demonstrated viewport.

`contingency mcp` binds `127.0.0.1` only (`CONTINGENCY_MCP_PORT`, default 7777) and prints `Contingency MCP Workspace available at http://127.0.0.1:<port>/` on stderr. This verification launch path does not start MCP. To prove a live Agent Session you must start `mcp` in its own isolated port and state dir; do not attach to an MCP process you did not start.

`mcp start` runs that server under a broker that holds one MCP stdio conversation open, so `mcp call --tool <name> --params <json>` reaches the same process that serves Workspace. That is the only way a drive can create an Agent Session: sessions live inside their owning process. A tool refusal prints its reason and exits `2`. The same broker answers `mcp resources` and `mcp resource --uri <uri>`, which is how a drive reads the authoring skills Contingency serves to a learning agent.

`mcp start` also sets `CONTINGENCY_CATALOG_ROOT` to `$CONTINGENCY_VERIFY_DIR/state/catalog`, so Flow Skills saved with `agent_flow_skill_save` and their Teaching Recordings land in the isolated state rather than the repository's `.contingency`. `cleanup` removes them with the rest of that state.

## Evidence

Put proof under `.cursor/skills/verify-contingency/artifacts/<feature-id>/`. Relative `--path` values are resolved there.

A proof is incomplete unless it includes:

- The user action (command plus handle), not an RPC or test helper that skips the UI.
- The resulting state (ARIA snapshot and screenshot for UI; stdout, stderr, and exit code for MCP tool calls).
- A second observation for mutations: reopen the view or read the written catalog under `$CONTINGENCY_VERIFY_DIR/state/catalog`.
- The feature id and entry point used.

Traces and Run videos are sensitive. Teaching, Dry Runs, and Interactive Runs may write them under the isolated state dir; do not copy them into `artifacts/` unless the feature file asks, and never reuse the user's real catalog.

Mocks are not allowed for Agent Sessions, Playwright, or the web UI. The ecommerce HTTP server (`control-contingency ecommerce start`) is verification scaffolding. Cleanup removes that server.

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
"$CONTROL" browser goto --path /
"$CONTROL" browser goto --url http://127.0.0.1:<mcp-port>/
"$CONTROL" browser wait --role heading --name "No browser session"
"$CONTROL" browser resize --width 390 --height 844
"$CONTROL" mcp start
"$CONTROL" mcp call --tool agent_sessions_get
"$CONTROL" mcp stop
"$CONTROL" fixture start            # alias for ecommerce start
"$CONTROL" cleanup
```

`launch` refuses if that verify dir already has a live pid. Two verification instances may run side by side because each picks its own port and catalog root. They must not share 7777, 5173, or the user's real catalog.
