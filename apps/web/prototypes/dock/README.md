# Prototype: Workspace dock layouts

Throwaway prototypes for the Workspace dock. A long agent sentence in the Run dock (a Dry Run's changed inputs plus the task instruction, or an agent's help request) wraps the dock's controls onto several lines. The dock sizes itself with viewport breakpoints, but it lives inside the browser stage, which the devtools inspector and the Dry Run Summary narrow independently of the viewport. At 1440 px with devtools docked right the dock gets 815 px. With the summary open as well it gets about 360 px.

This is not production code. It renders the app's own `ui/` primitives, `Wordmark`, `DockShell`, `DockStatus`, `RailButton`, `ShortcutKbd`, and `WorkspaceWithRunSummary`, so every prototype looks like the Workspace. It does not touch the Workspace route.

## Run it

```bash
cd apps/web
nub exec vite --config prototypes/dock/vite.config.ts
# open http://127.0.0.1:5180/
```

The grey strip at the top is prototype scaffolding, not proposed UI. It switches the prototype, the dock state, and the Workspace layout around the dock. The theme toggle is the real one in the browser toolbar. Every choice is mirrored into the URL (`?variant=pill&scenario=dry-run&layout=devtools-right&theme=dark`). Add `capture=1` to hide the strip.

## Capture the evidence again

```bash
cd apps/web/prototypes/dock
PLAYWRIGHT=/path/to/playwright-core OUT=/tmp/dock-shots node capture.mjs
```

The script captures 5 prototypes × 5 states × 5 Workspace layouts × 2 themes at 1440 × 900, plus phone shots at 390 × 844 and one shot per prototype with its details open. It logs each dock's measured height and the stage width it had, and exits non-zero if a dock extends past the stage. `VARIANTS`, `SCENARIOS`, `LAYOUTS`, and `THEMES` narrow the matrix.

## The prototypes

All four size themselves with container queries on the stage instead of viewport breakpoints. That one change fixes the wrapping at every devtools and summary width.

| Prototype | Shape | Agent sentence | Narrow stage |
| --- | --- | --- | --- |
| Current | Floating card, wraps | Inline `DockStatus` | Controls wrap under the sentence; 202–306 px tall |
| A · Two-tier card | Status line above one toolbar row | One clamped line with an expand chevron. Expanding shows the Agent Step and the task in place | Sentence drops under the badge; secondaries and coverage fold into **More** |
| B · One-line pill | One 48 px row | Fills the leftover width and truncates. Clicking it opens one popover with the sentence, Agent Step, and task | Session select, coverage, and idle fold into **More**; the sentence becomes an info button |
| C · Agent bubble | Bubble above a controls-only dock | Two-line bubble with **More** and minimise | Select folds into **More** below 28 rem |
| D · Edge bar | Bar fixed to the stage's bottom edge | Truncated; expands as a drawer above the bar | Splits into a status row and a controls row |

## Revision 2: the two-tier card with requests

The two-tier card (A) was picked. Revision 2 changes it in three ways:

- The session picker is the shadcn `Select`, as the device bar uses it, instead of a native select. The baseline keeps the native one.
- A paused Execution Boundary becomes the dock's first tier: a title naming what is confirmed, the requested action, and a one-line pointer to the agent conversation with a copyable decision id. The action attempt, its JSON, and the policy sentence sit behind **Details**. A description identical to the request is not repeated.
- Input requests join the same tier. Inputs supplied in the Workspace get one row each (name, purpose, password field with reveal and **Supply**, quiet **Refuse**); inputs answered in the agent conversation show the variable, its scope, and the decision id.

Each request collapses to one line (its title and the requested action, or the count still needed) from a chevron beside its title, and the line reopens it. The collapse is keyed to the request, so a new boundary or input reopens the tier. Add `collapsed=1` to the harness URL, or `COLLAPSED=1` to the capture script, to start folded.

The baseline renders today's request cards through the real `DockNotices`, so the before and after compare in the same Workspace.

## Files

- `fixtures.ts` holds the five dock states, with strings shaped like `runDockPresentation` and `teachingRecordingPresentation` output.
- `parts.tsx` holds the shared dock pieces, built from `ui/` with the shipped docks' classes.
- `variants.tsx` holds the current dock and the four prototypes.
- `requests.tsx` holds the request tier: the Execution Boundary and input requests.
- `legacy-notices.tsx` copies today's request cards for the baseline.
- `frame.tsx` is a stand-in Workspace: the toolbar, the dotted stage, a devtools panel at its real default sizes, the inspector rail, and the real `WorkspaceWithRunSummary`.
- `capture.mjs` takes the screenshots.
