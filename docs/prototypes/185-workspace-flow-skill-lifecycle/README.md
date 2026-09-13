# Prototype: recorded Flow Skill Workspace lifecycle

Throwaway prototype for [#185](https://github.com/akshat-OwO/contingency/issues/185). It exists to settle the Workspace interaction for [ADR 0039](../../adr/0039-flow-skills-are-learned-from-temporary-teaching-recordings.md) before production code changes the session model. It is not production code and it does not touch the Workspace route.

## Run it

```bash
cd docs/prototypes/185-workspace-flow-skill-lifecycle
python3 -m http.server 4319
# open http://127.0.0.1:4319/index.html
```

The grey strip at the top is prototype scaffolding, not proposed UI. It switches layout, steps through every Teaching state (`j` and `k` also step), and toggles dark mode.

## Capture the evidence again

```bash
npm i playwright-core --prefix /tmp/protoshot
NODE_PATH=/tmp/protoshot/node_modules node capture.mjs
```

`capture.mjs` walks 11 states across 3 layouts, 2 themes, and 2 viewports, writes 132 screenshots to the ignored `shots/` directory, and fails on duplicate accessible names, clipped controls, and page overflow. The curated screenshots in `review/` come from that run. `review/checks.txt` holds its verdict.

## Layouts compared

| Layout | Where status and the primary action live |
| --- | --- |
| Status bar | Top bar owns the primary action. A one-line strip under it owns status, next step, progress, and secondary actions. |
| Action dock | Top bar stays as sketched. A floating dock over the browser owns status, progress, and every action. |
| Detail rail | Top bar owns the primary action. A 19rem right rail owns status, progress, files, and secondary actions. |

Measured differences, from `capture.mjs` and a keyboard walk:

- The rail hides below `lg`. At 390px the dry-run-passed state loses status, the files, and **Reject flow** entirely. See `review/mobile-rail-loses-actions.png`.
- The dock reaches the primary action after 9 tabs, because the browser toolbar precedes it in the DOM. The status bar reaches it after 1.
- The rail costs 19rem of browser width at every state, including the states with nothing to report.
- The status bar strip is the only layout that fits the full next-step sentence plus the file paths at 1440px without truncating.

**Recommendation: status bar.** It matches the sketch, keeps the browser the largest thing on screen, puts the primary action one tab away, and has no state where a control disappears. The dock is the fallback if the strip ever needs to hold more than one line.

## State contract

State names are the `TeachingCaptureState` tags from ADR 0039. `no session` is the Workspace-level empty state, not a Teaching state.

| State | Status headline | Primary action | Secondary actions | Capture indicator |
| --- | --- | --- | --- | --- |
| no session | No browser session yet | none in the bar, **Open browser session** in the canvas | View saved flows | Nothing captured |
| setup | Setup is private | Start recording | Rename flow | Not recording |
| recording | Recording the journey | Stop | Add instruction | Recording, with a timer and a red frame |
| finalizing | Saving the recording | none | none | Saving, with a progress bar |
| ready | Recording ready to learn | Learn flow | Copy agent prompt, Delete recording | Recording saved |
| learning | Agent is writing the flow skill | Cancel learning | none | Recording saved, with bounded progress |
| skill-drafted | Flow skill drafted | Dry run | Read flow skill, Learn again | Recording kept until verified |
| dry-running | Dry run in progress | Stop dry run | none | Recording kept until verified, with bounded progress |
| dry-run-passed | Dry run passed with a changed quantity | Verify flow | Reject flow, Read flow skill | Recording kept until verified |
| verified | Flow verified and recording deleted | Run flow | Read flow skill, Record another flow | Recording deleted |
| failed (cleanup) | The flow is verified. Deleting the recording failed | Retry cleanup | Show retained files | Video and trace still on disk |

### Transition rules

- `no session` to `setup` on **Open browser session**, or when an agent opens a Teaching session over MCP.
- `setup` to `recording` on **Start recording** only. No other path starts capture.
- `recording` to `finalizing` on **Stop**.
- `finalizing` to `ready` when the recording is written. The Workspace never offers an action here.
- `ready` to `learning` on **Learn flow**, or when an attached agent starts learning.
- `learning` to `skill-drafted` when the agent saves the Flow Skill. **Cancel learning** returns to `ready`.
- `skill-drafted` to `dry-running` on **Dry run**. **Learn again** returns to `learning`.
- `dry-running` to `dry-run-passed` on a pass, and to `skill-drafted` on a failure with the failure shown.
- `dry-run-passed` to `verified` on **Verify flow**, the only action that authorizes deletion. **Reject flow** returns to `skill-drafted` and keeps the recording.
- `verified` to `failed (cleanup)` when deletion fails. **Retry cleanup** repeats it and converges on `verified`.

### Rules the prototype settled

- The session selector's main label is the Flow Skill name. Its second line carries the Teaching state, never a session id. A raw id belongs in the dropdown row, not the button.
- Every state names the next step in one sentence beside the headline. A state with no next step has no primary action, which is why `finalizing` offers none.
- A disabled repeat of the previous primary action is not a status. States with work in flight offer the action that stops that work, or nothing.
- Setup navigation, device, emulation, and storage controls stay on the browser frame in every state, including while recording.
- Agent progress is one line of muted text and one bounded bar. It never gets a panel of its own.
- The empty canvas owns the invitation in `no session`, so the top bar shows no primary action there. Two buttons reading **Open browser session** was the first thing `capture.mjs` caught.
