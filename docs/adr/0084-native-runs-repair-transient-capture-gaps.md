---
status: accepted
---

# Native Runs repair transient capture gaps

> Decided in [#720](https://github.com/akshat-OwO/contingency/issues/720) and [#721](https://github.com/akshat-OwO/contingency/issues/721).

An Android or iOS capture is complete only when the accessibility tree holds the app's window. During a screen transition, such as the loading screen between choosing a delivery location and the homepage, the first capture after a tap can lack that window. A capture a moment later is complete. Before this decision, that first capture paused the session with `capture_incomplete`. Only the user's Workspace **Recover** could resume it, and the gap stayed in the summary, so the Dry Run could never pass. One ordinary navigation made a working Flow unverifiable.

## Rules

- **A transition is an incomplete capture however it is reported.** On Android, agent-device either returns the snapshot, which `requireCapture` refuses, or raises a retriable snapshot-helper failure (`content-poor-app-window`, `empty-helper-output`, `system-window-only`). Both are `capture_incomplete`. The raised form used to surface as `runtime_failed`.
- **An incomplete capture is taken again before it counts.** The shared native runtime captures again every 250 milliseconds for up to 5 seconds while the capture stays `capture_incomplete`. A complete capture inside that window is the observation. It records no gap and sends no input. iOS also keeps its own settling of stale captures.
- **An agent-controlled Run or Dry Run repairs a lasting gap once.** When the window passes, the workspace runs the same same-device recovery as **Recover**: it reopens the owned device session and observes again. It never repeats the action that came before the gap. If the fresh capture is complete, the session keeps running, and the gap is recorded in `captureGaps` with an `automatic` entry in `captureRepairs`. If recovery fails too, the session pauses as before.
- **The agent's own `recover` command stays refused.** Only the runtime's single repair skips the user. Teaching, and a Run the user controls, still pause on a lasting gap.
- **A repaired gap is evidence, not a failure.** The user's **Recover** marks the open gaps `user` in `captureRepairs`. A Dry Run passes when no gap is open, because the observation it assesses was captured after the last repair. A secure window, unverified Forwarded Input, and Takeover still block a pass.

## Consequences

- The session summary and the Run Summary keep every gap, so a reader can still see that a transition went wrong. Persisted summaries without `captureRepairs` read as having no repairs.
- A gap that outlasts 5 seconds and a recovery is a real problem, and it still asks the user.
- Recovery reopens the device session without the user, which the earlier contract reserved for the user. It does so only for `capture_incomplete` in agent-controlled Runs, where the device and app are the ones the session prepared.
