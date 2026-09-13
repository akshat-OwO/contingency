# Prototype: recorded Flow Skill Workspace lifecycle

Throwaway prototype for [#185](https://github.com/akshat-OwO/contingency/issues/185). It exists to settle the Workspace interaction for [ADR 0039](../../adr/0039-flow-skills-are-learned-from-temporary-teaching-recordings.md) before production code changes the session model. It is not production code and it does not touch the Workspace route.

## Run it

```bash
cd docs/prototypes/185-workspace-flow-skill-lifecycle
python3 -m http.server 4319
# open http://127.0.0.1:4319/index.html
```

The grey strip at the top is prototype scaffolding, not proposed UI. It steps through every Teaching state (`j` and `k` also step) and toggles dark mode.

## Capture the evidence again

```bash
npm i playwright-core --prefix /tmp/protoshot
NODE_PATH=/tmp/protoshot/node_modules node capture.mjs
NODE_PATH=/tmp/protoshot/node_modules node inspect-check.mjs
```

`capture.mjs` walks 12 states across 2 themes and 2 viewports, writes 48 screenshots to the ignored `shots/` directory, and fails on duplicate accessible names, clipped controls, and page overflow, and exits non-zero when anything fails. `inspect-check.mjs` drives the inspect and comment flow and prints what it observed. The curated screenshots in `review/` come from those runs, and `review/checks.txt` holds the verdict.

## Layout

One floating dock over a full-bleed browser. There is no header and no footer, so the browser gets every pixel the dock does not.

The dock holds, left to right: the `Contingency` wordmark, the session select, the state badge, the next-step sentence, agent progress when there is any, the inspect toggle, secondary actions, and the primary action.

Rules the dock follows:

- The session select shows the Flow Skill name and nothing else. The Teaching state lives in its own badge beside it. A raw session id never appears in either.
- No paired heading and subtitle anywhere. Each state gets one line of status text, and the badge carries the state itself.
- Below `lg` the status sentence takes its own line inside the dock, and below `sm` it is hidden entirely, because the badge and the buttons already carry the state and the next step. It is never ellipsized.
- The browser chrome bar keeps navigation, device, emulation, and storage available in every state, including while recording.
- Recording draws a red inset ring around the whole frame.
- The Flow Skill files render on the page as a card from `skill-drafted` onward, not in the dock.

Two earlier layouts, a top status bar and a right detail rail, were cut. The rail hid below `lg` and lost **Reject flow** at 390px, and the status bar spent a second horizontal band on what the dock already carries.

## Inspect and comment

The dock's cursor icon replaces the old **Add instruction** button. Toggling it puts the browser frame in inspect mode.

- Hovering outlines the element under the pointer and labels it with `tag#id.class`.
- Clicking freezes the selection and opens a comment box with a **Describe the change** field, **Cancel**, and **Attach**.
- Attaching pins a numbered marker on the element and counts the comments in the dock.
- `Escape` leaves inspect mode.

Available in `recording`, `skill-drafted`, `dry-run-failed`, and `dry-run-passed`. During recording a comment is an instruction on the demonstration. After a draft it is a correction to the Flow Skill.

The mock shop page inside the frame stands in for the browser screencast. Production renders a real frame. The prototype needs real elements so inspect has something to select.

## State contract

State names are the `TeachingCaptureState` tags from ADR 0039. `no session` is the Workspace-level empty state, not a Teaching state.

| State | Badge | Next-step text | Primary action | Secondary actions |
| --- | --- | --- | --- | --- |
| no session | No session | Open a session to set the browser up, then start recording when the journey begins. | none in the dock, **Open browser session** in the canvas | View saved flows |
| setup | Not recording | Sign in, pick emulation, and edit storage. Nothing is captured until you start recording. | Start recording | Rename flow |
| recording | Recording, with a timer | Do the journey once. Press stop on the page that proves it worked. | Stop | inspect toggle |
| finalizing | Saving | Writing video, trace, and actions. This takes a few seconds. | none | none |
| ready | Recording saved | Ask an agent to learn this recording, or start learning here. | Learn flow | Copy agent prompt, Delete recording |
| learning | Learning | Keep using the browser. The flow skill appears here when it is drafted. | Cancel learning | none |
| skill-drafted | Flow skill drafted | Dry-run it with different inputs to see whether it reuses the journey. | Dry run | Read flow skill, Learn again, inspect toggle |
| dry-running | Dry run | The flow skill is running in a fresh browser with a changed quantity. | Stop dry run | none |
| dry-run-failed | Dry run failed | Step 4 could not find the place order button. Comment on the page, then learn again or dry-run once more. | Dry run | Read failure, Learn again, inspect toggle |
| dry-run-passed | Dry run passed | Verify the flow to keep it and delete the recording. Reject to keep the recording. | Verify flow | Reject flow, Read flow skill, inspect toggle |
| verified | Recording deleted | The flow skill and its references are all that is left. Run it any time. | Run flow | Read flow skill, Record another flow |
| failed (cleanup) | Video and trace still on disk | recording.webm and trace.zip are still in .contingency/.recordings/r-48219. Retry the deletion. | Retry cleanup | Show retained files |

### Transition rules

- `no session` to `setup` on **Open browser session**, or when an agent opens a Teaching session over MCP.
- `setup` to `recording` on **Start recording** only. No other path starts capture.
- `recording` to `finalizing` on **Stop**.
- `finalizing` to `ready` when the recording is written. The Workspace never offers an action here.
- `ready` to `learning` on **Learn flow**, or when an attached agent starts learning.
- `learning` to `skill-drafted` when the agent saves the Flow Skill. **Cancel learning** returns to `ready`.
- `skill-drafted` to `dry-running` on **Dry run**. **Learn again** returns to `learning`.
- `dry-running` to `dry-run-passed` on a pass, and to `dry-run-failed` on a failure.
- `dry-run-failed` to `dry-running` on **Dry run**, and to `learning` on **Learn again**. The recording stays.
- `dry-run-passed` to `verified` on **Verify flow**, the only action that authorizes deletion. **Reject flow** returns to `skill-drafted` and keeps the recording.
- `verified` to `failed (cleanup)` when deletion fails. **Retry cleanup** repeats it and converges on `verified`.

### Rules the prototype settled

- A state with no next step has no primary action, which is why `finalizing` offers none.
- A disabled repeat of the previous primary action is not a status. States with work in flight offer the action that stops that work, or nothing.
- Agent progress is one bounded bar plus one short label. It never gets a panel.
- The empty canvas owns the invitation in `no session`, so the dock shows no primary action there. Two buttons reading **Open browser session** was the first thing `capture.mjs` caught.
