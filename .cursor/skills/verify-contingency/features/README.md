# Contingency verification map

This directory is the maintained source for verifying Contingency's user-facing behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Build the current source with `nub exec turbo run build --filter=@contingencyhq/cli --force`. The CLI embeds Workspace; an existing or cached CLI bundle alone does not prove current web source.
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
- Run nested Workspace site actions through `computerUse` at the verification URL. The `browser input-check` command drives its dedicated fixture through the canvas.
- Use `browser scroll-check --session-id <id> --record` for bounded native wheel measurements before and during Teaching. Start from user-held setup and read its canvas timing JSON, gesture screenshots, and recorded semantic Timeline.
- Restore nothing in the user's real `.contingency` catalog. Isolated state is deleted on cleanup. Proof artifacts are not.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the Contingency wordmark visible.
- Mutation proof includes a read-only second view: reopen the route, or read the written catalog files under the isolated state directory.
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

- [Overlay recovery](./workspace.md#overlay-recovery) proves interception of background input, stacked sheets, unnamed and image close targets, focus-time popup races, and reachable edges without reload.

- [Agent onboarding](./workspace.md#agent-onboarding) proves session-only agent launch, bundled Examples, private demo Variables, fresh Dry Runs, verification, project-local reuse, registration, and shutdown.

- [Dry Run prerequisites](./workspace.md#dry-run-prerequisites) proves startup-fixed verified setup skills, private Workspace supply and refusal, skill-scoped replacement, and a complete cart outcome in one fresh context using the gated prerequisite shop.

- [Teaching setup Variables](./workspace.md#teaching-setup-variables) proves private Workspace supply and refusal before recording, replacement and replay, masking across handoff, and setup-free learned inputs with the isolated sign-in fixture.

- [Teaching navigation evidence](./workspace.md#teaching-navigation-evidence) proves transitional navigation metadata and each keyframe's capture URL with delayed and immediate destination rendering.

- [Workspace](./workspace.md) is the UI recipe for navigation, streaming diagnostics and preferences, scaled Inspect alignment, rapid canvas input, Browser Snapshot coverage, scoped compact text, continuation, context and layered sheets, large-cart Inspect and retry feedback, delayed navigation and Session URL sync, the Teaching Start/Stop capture boundary, Run-owned Agent Assessment evidence, complete or partial Dry Run outcome reports, task-directed Interactive Runs with browser continuity and lazy skill-scoped inputs, and task details, responsive Dry Run results, exact private segmented-code acceptance with delayed and missing-length fixtures, and persisted task and historical Run Summaries.
- [Execution Boundary](./workspace.md#execution-boundary) proves direct Workspace Allow and Refuse, Takeover restrictions, stored single and sequence resumption, and dispatch-once replay.
- [Combined task proof](./workspace.md#combined-task-proof) runs `agent-task-combined-proof`, `agent-dry-run-outcomes`, and `agent-summary-restart-proof` together. Its command journal, MCP responses, snapshots, screenshots, persisted rereads, and explicit blockers stay under `artifacts/task-proof/` after cleanup.
- [Skills drawer](./workspace.md#skills-drawer) proves the dock's `Skills` entry across dock states, local-first listing with a folded `Global` root isolated under the verify directory, Runs and recordings grouped by skill, the `Details` panel, session marks, and the empty and no-match states.
- [Required scans](./workspace.md#required-scans) proves scan buttons, taught timespan boundaries, durable scan references, real Lighthouse and axe reports, interruption, required coverage, scoped retries, and report downloads.
