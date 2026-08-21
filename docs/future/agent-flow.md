# Future: Agent Flow

Vocabulary: [`CONTEXT.md`](../../CONTEXT.md). Decisions: [`docs/adr/`](../adr/). Build sequence this follows: [`product-path.md`](./product-path.md).

**Sequencing: this starts after Audit View is complete.** Nothing here is decided yet — no ADR has been written, and the design below is the shape agreed on, not a commitment.

## Problem

Complex sites ship fast, several teams change the same flows at once, and experiments run continuously. A Flow that pins concrete selectors breaks on changes that a human would not consider breakage — a button moved, two steps merged, a dropdown became a modal. The failure that matters is not a stale selector but a **Step whose intent still exists while its path changed**.

## Shape

Not a new entity: the same Flow, the same Runner, the same report shape. What is new is a Step capability and a Flow-level mode. A Step may carry a free-text **intent** plus a machine-checkable success condition, and its concrete action path becomes derived rather than authored.

### Authoring

- Record through Contingency's own **Recording** — not an externally supplied screen capture, so the action trace and DOM are available alongside video.
- Annotations are optional: free text to explain intent, and an explicit control to place an Audit (an audit point is a choice, not something parsed out of prose).
- A compile-time agent reads video plus the ordered action trace and emits a **proposal the author accepts** in Create View — never a silent artifact.
- One recorded Step is one intent. A multi-Step intent span (`everything from here to there = add SKU to cart`) is reserved in the format and not built; per-Step intents handle a consolidated flow worst, so this is where to look first if that turns up.

### Two artifacts, two lifecycles

|  | Lives in | Written by | Tracked in git |
| --- | --- | --- | --- |
| `intent` + success condition | the Flow file | a human | yes |
| compiled action path | a derived cache, keyed by Flow + environment | the Runner | no |

The Flow states what must be true; the cache records how it was last achieved here. Staging and production legitimately differ, so the cache cannot be a single shared path. The cache being deletable is the safety property: a bad repair is recovered by discarding it, not by reverting a commit nobody knew happened.

### Execution

- Replay from the cache; the **Runner** evaluates the success condition. The agent's own assessment of whether it succeeded is a hint, never the verdict — the condition is extracted at compile time from the demonstration's end state.
- When replay breaks, the agent proposes actions and the Runner executes them (amends [ADR 0002](../adr/0002-cli-is-the-sole-runner.md): the sole Runner may take its next action from a model rather than from a file). Observe–reason–act, choosing a screenshot or the accessibility tree per step.
- Intent text is authoritative. The video is a debugging exhibit and, at most, an aged hint — it shows the site as it was, which is least accurate exactly when a Step has broken.

### Outcomes

Three-valued, because a failed Step is either a broken site or a bad guess, and reporting the second as the first makes the alert channel unusable:

- `achieved`
- `achieved-by-different-path` — the new path is recorded, the Run is flagged path-divergent, and Regressions against a Baseline that took another path are reported unconfirmed rather than alerted (the posture [ADR 0010](../adr/0010-run-video-is-unredacted.md) already takes on recorded-vs-unrecorded comparison).
- `not-achievable`, after the retry budget — **aborts the Run at that Step.** Never skip: a Flow whose middle Step did not happen produces Findings about pages nobody reached.

`--interactive` lets a present human answer what to fill or what to do when stuck. It reuses the existing `runtime` **Variable** prompt path rather than adding a parallel one, and refuses to arm when stdin is not a TTY.

### Audits stay deterministic

The model may propose audit points at compile time; where Audits run is fixed in the Flow ([ADR 0005](../adr/0005-audits-are-ordered-custom-steps.md)). A per-Run decision to audit a page would make an unaudited page report zero Findings, and a Baseline diff would read every previous Finding there as fixed — corruption in the reassuring direction.

## Alpha scope

Ship without the CI-facing machinery: automatic Handoff on repair and non-comparable run marking can wait while every Run has a human watching it. Keep the intent/cache split from the start regardless — it costs nothing now and is a painful migration later.

## Open before any Run against a site the operator does not own

An agent that can reason its way to "add SKU to cart" can reason its way into completing a purchase or deleting an account, and the demonstration is the only evidence of what is in bounds. Needs a domain allowlist, a blocked-action list, and a per-intent step budget, all enforced at the Runner rather than stated in a prompt. Related: [ADR 0010](../adr/0010-run-video-is-unredacted.md) records that video holds secrets in plaintext, and this design feeds recordings to a model — the compile agent should receive the action trace with redacted values.

## Decisions to write down when this starts

- A new ADR for the mode itself.
- [ADR 0001](../adr/0001-flow-as-chrome-recorder-json.md): where `intent` and the success condition serialize without breaking Chrome Recorder import. Everything else is written on top of this one — start here.
- [ADR 0002](../adr/0002-cli-is-the-sole-runner.md): model-proposed actions, Runner-executed.
- [ADR 0005](../adr/0005-audits-are-ordered-custom-steps.md): Audits remain deterministic under an agent-driven Run.
- [ADR 0010](../adr/0010-run-video-is-unredacted.md): recordings now reach a model.
