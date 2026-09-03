# Contingency verification map

This directory is the maintained source for verifying Contingency's user-facing behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Build `@contingency/cli` so `packages/cli/dist/index.js` and `packages/cli/dist/web/index.html` exist.
- Launch with `control-contingency launch` so the UI is the production SPA on an ephemeral `127.0.0.1` port, not Vite `:5173` and not a borrowed `:7777`.
- Export `CONTINGENCY_VERIFY_DIR` from launch stdout.
- Run `control-contingency doctor` and require `ok`, the printed URL, and a `stateDir` under that verify directory.
- Never drive an instance that this run did not start.
- For site-backed drives, run `control-contingency ecommerce start` and export `ECOMMERCE_URL` from stdout.

## Driving conventions

- Start every recipe from `/` unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or canvas coordinates.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run Contingency chrome actions through `control-contingency browser`.
- Run nested Create View site actions through `computerUse` at the verification URL.
- Run headless Flows through `control-contingency cli --`.
- Restore nothing in the user's `~/.local/state/contingency`. Isolated state is deleted on cleanup. Proof artifacts are not.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the Contingency wordmark visible.
- CLI proof includes the command, stdout, stderr, exit code, and the Run directory printed by the CLI.
- Mutation proof includes a read-only second view: reopen the route, or read `run.json` under the isolated runs directory.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-contingency` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Ecommerce end-to-end drive](./ecommerce-drive.md) is the canonical proof: browse the local shop, switch sessions, record a cart Flow, download JSON, audit-run it, and scrub/play derived frames.
- [Create View](./create-view.md) covers the authoring workspace, session picker, address bar, Recording start, and captured Steps.
- [Audit View](./audit-view.md) covers the empty state, loading a Flow from the process argument or file picker, starting a Run, and derived-frame playback.
- [Agent View](./agent-view.md) covers the unavailable state on `web`, the empty state when MCP has no session, a live session's Takeover (the browser toolbar, the canvas, and the action timeline), and Teaching: relaying instructions, entering private Variables, reading the Teaching Feed, saving a draft Agent Flow, and finding it by catalog search.
- [Headless Run](./cli-run.md) covers `contingency run` against the ecommerce smoke Flow.
