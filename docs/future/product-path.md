# Future product path

Vocabulary: [`CONTEXT.md`](../../CONTEXT.md). Decisions: [`docs/adr/`](../adr/). Create streaming today: [`../architecture/create-browser-streaming.md`](../architecture/create-browser-streaming.md).

This doc is the build sequence implied by the domain model — not a sprint plan.

## 1. Flow schema

- A native Contingency document — not Chrome DevTools Recorder JSON ([ADR 0011](../adr/0011-flow-is-a-native-format.md)). No import, no converter, no backward compatibility.
- **Steps**: navigate, click, change, keyDown/keyUp, press, hover, scroll, selectOption, waitFor, plus ordered accessibility Audits. An assertion Step is deferred deliberately.
- Each Step's target is an ordered array of structured locator descriptors (role + accessible name → label → placeholder → text → CSS → XPath), resolved first-match-wins.
- Flow-level declarations: default **Pre-steps**, per-**Step** Pre-steps, **Variables**, **Emulation** ([ADR 0013](../adr/0013-emulation-belongs-to-the-flow.md)), and a **Gate** ([ADR 0018](../adr/0018-a-gate-fails-the-exit-code-not-the-run.md)).
- Pre-step conditions are a closed set: `selectorVisible`, `selectorHidden`, `urlMatches` ([ADR 0022](../adr/0022-pre-step-conditions-gain-hidden-and-url.md)).
- Pre-steps: no nested Pre-steps, no Audits on Pre-steps.

## 2. Create View: Recording → Flow

- Wire “Start recording” to a **Recording** session (not a Run).
- Capture canvas/browser interactions as native **Steps**: hover by explicit author gesture, scroll coalesced per resting position, popups and new tabs recorded as further Pages.
- Let the author add ordered Audit Steps and edit Flow/Step Pre-steps for ads, popups, cross-sells.
- Export/save the result as a Flow JSON file.

Depends on: live browser streaming (done), Flow schema.

## 3. Runner and Run lifecycle

- Implement the **Runner** in the CLI only ([ADR 0002](../adr/0002-cli-is-the-sole-runner.md)).
- A **Run**: load Flow → for each Step after initial navigation, evaluate Flow/Step Pre-steps → execute an action or Audit Step → collect **Findings** from Audits.
- Headless: `contingency` CLI entrypoints that produce Runs without the web UI.
- Audit View: import/open a Flow, start/attach to a Run via the CLI Runner, stream progress, step the Run timeline for inspection (no browser time-travel).

## 4. Baseline, Regression, Alert

- Persist Runs so a Flow can designate a **Baseline** (default: previous Run; optional explicit pin).
- **Regression** = Finding new or worsened vs Baseline.
- **Alert** = notification payload/channels fired from a Run when Regressions exist.
- Scheduling of Runs (cron, CI) stays outside Contingency — no Monitor entity.

## 5. Handoff

- When Regressions (or selected Findings) warrant action, emit a **Handoff** for an external agent ([ADR 0003](../adr/0003-fixes-via-external-handoff.md)).
- Payload should identify Flow, Step, Findings/Regressions, and enough context for a fixer; Contingency does not apply patches.

## Suggested build order

```text
Flow schema
    → Recording in Create View
    → Runner (headless CLI Run)
    → Audit View observes Runner
    → Baseline / Regression / Alert
    → Handoff API
```
