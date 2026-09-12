---
name: maintain-verification-skill
description: Update verify-contingency when Contingency's user-facing behavior changes. Use when adding verification paths, extending the local ecommerce fixture, or teaching agents how to drive the Workspace end to end.
---

# Maintain verification skill

`verify-contingency` is the runnable map for driving Contingency's local UI and CLI. This skill tells you how to keep that map accurate and how agents should exercise the product.

## Source of truth

- Skill root: `.cursor/skills/verify-contingency/`
- Harness: `.cursor/skills/verify-contingency/bin/control-contingency`
- Feature recipes: `.cursor/skills/verify-contingency/features/`
- Ecommerce fixture: `.cursor/skills/verify-contingency/fixtures/ecommerce/`
- Evidence: `.cursor/skills/verify-contingency/artifacts/` (gitignored)

`.claude/skills/verify-contingency/` and `.agents/skills/verify-contingency/` are symlinks to that directory, so editing the source is the whole update. Do not replace them with copies.

## Canonical agent drive

Agents proving Contingency should follow `verify-contingency/SKILL.md` and the feature files. The primary UI recipe is `features/workspace.md`. It covers the sole route at `/`, user-led Teaching, Verification Runs, Interactive Runs, and persisted Run Summaries. Start the local ecommerce fixture for browser journeys.

`features/workspace.md` is the only recipe: the deterministic Create View, Audit View, headless-Run, and ecommerce-drive recipes were deleted with that stack.

## Two driving surfaces in the Workspace

Contingency chrome and the nested browser session are different surfaces.

| Surface | What it is | How to drive |
| --- | --- | --- |
| Contingency chrome | Primary nav, session combobox, address bar, session sidebar | `control-contingency browser` with ARIA roles/names |
| Nested ecommerce site | Live Chromium inside the workspace canvas | `computerUse` subagent at the verification URL |

`control-contingency browser` must not click the canvas as if it were the nested page DOM. Nested browse/click/scroll/hover/type belongs to `computerUse` (or a future nested-browser harness command).

## When to update feature files

Update a feature file when any of these change:

- Accessible names or roles in the Workspace or CLI output
- Preconditions for launching, fixtures, or isolated state
- User-visible phases (`active`, `Completed`, download filenames, etc.)
- Stable proof artifacts agents must capture

Keep feature files user-POV. Put harness flags and exact commands in `Driving it with control-contingency`.

## When to update the harness

Extend `control-contingency` when a user action has no faithful CLI equivalent, for example:

- Serving multi-page ecommerce fixtures instead of a single HTML stub
- `mcp call` for tools only an MCP client can reach, such as starting the Agent Session a live Workspace drive needs

Do not change product code to make verification easier unless the product behavior itself is wrong.

## Ecommerce fixture rules

The verification ecommerce site lives only under `fixtures/ecommerce/`. It is scaffolding, not product code.

- Serve it on `127.0.0.1` via `ecommerce start`; never hard-code ports.
- Keep selectors stable: prefer roles, labels, and button text the user can recognize.
- `shop.html` is the home URL printed by `ecommerce start`.
- Cart state uses `sessionStorage` so cart replay works in the same browser session.

When adding pages or SKUs, update `workspace.md` and any smoke Flow titles in `fixture start`.

## Editing checklist

1. Change harness and/or fixtures under `.cursor/skills/verify-contingency/`.
2. Update the relevant `features/*.md` recipes and `features/README.md` index.
3. Update `verify-contingency/SKILL.md` if launch/doctor/drive/cleanup contracts change.
4. Run a real drive: `launch` → `doctor` → `ecommerce start` → Workspace steps → `cleanup`. For Workspace, add `mcp start` and the `workspace.md` live-session steps.
5. Confirm evidence under `artifacts/` survives `cleanup`.

## Triage and agent briefs

`/triage` may reference verify-contingency in agent-brief acceptance criteria when an issue touches user-visible behavior. See `docs/agents/verification.md` for when to require it and which feature recipe to cite.

If an implementing change alters accessible names, MCP-visible outcomes, drive steps, or fixture behavior, update feature files and the harness in the **same PR** — not as follow-up work.

If the change is internal only (catalog metadata, protocol fields with no new user-visible surface), triage should mark updating verify-contingency as out of scope for that issue.
