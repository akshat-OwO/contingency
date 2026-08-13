# Future product path

Vocabulary: [`CONTEXT.md`](../../CONTEXT.md). Decisions: [`docs/adr/`](../adr/). Create streaming today: [`../architecture/create-browser-streaming.md`](../architecture/create-browser-streaming.md).

This doc is the build sequence implied by the domain model — not a sprint plan.

## 1. Flow schema

- Adopt Chrome DevTools Recorder JSON as the base document.
- Define Contingency extension fields:
  - Flow-level default **Pre-steps** (Step-shaped actions + explicit `when` condition).
  - Per-**Step** Pre-steps (override/add) and zero or more **Audits**.
- Pre-steps: no nested Pre-steps, no Audits on Pre-steps.
- Plain Chrome exports remain valid Flows (extensions absent).

## 2. Create View: Recording → Flow

- Wire “Start recording” to a **Recording** session (not a Run).
- Capture canvas/browser interactions as Chrome-shaped **Steps** (same spirit as Chrome’s recorder).
- Let the author attach Audits per Step and edit Flow/Step Pre-steps for ads, popups, cross-sells.
- Export/save the result as a Flow JSON file; accept paste/import of Chrome Recorder JSON.

Depends on: live browser streaming (done), Flow schema.

## 3. Runner and Run lifecycle

- Implement the **Runner** in the CLI only ([ADR 0002](../adr/0002-cli-is-the-sole-runner.md)).
- A **Run**: load Flow → for each Step, evaluate Flow/Step Pre-steps → execute Step actions → run attached Audits → collect **Findings**.
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

## UI copy debt

Create’s instructions panel still says “workflow” / “semantic steps.” When Recording lands, align copy with **Flow**, **Step**, and **Recording** from `CONTEXT.md`.
