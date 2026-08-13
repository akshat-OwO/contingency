# Contingency

Contingency lets companies author and re-run website Flows that check performance and accessibility, surface Findings, and feed agent-driven fixes.

## Language

**Flow**: Contingency's primary durable artifact: Chrome DevTools Recorder–compatible JSON extended with Contingency fields (for example pre-steps and per-step audits). _Avoid_: Workflow, recording (as the saved artifact), contingency project

**Create View**: The authoring mode over a Flow: live browser on a canvas, record steps, attach audits and pre-steps. _Avoid_: Create product, editor (as the product name)

**Audit View**: The execution and inspection mode over a Flow: import or open a Flow, watch a Run, step through the Run timeline to inspect a Step's actions and Findings. It observes the CLI Runner rather than executing Flows itself. Stepping back does not rewind browser state or fork the Run. _Avoid_: calling this mode itself "an Audit"

**Audit**: A pluggable check attached to a Step that produces Findings. A Step may have zero or more Audits. v1 check kinds are accessibility and performance. _Avoid_: Audit View, axe, Lighthouse (those are implementations)

**Step**: One Chrome DevTools Recorder–shaped user action in a Flow (click, fill, navigate, and so on). Audits and Pre-steps attach to it. _Avoid_: semantic step, page, checkpoint (as synonyms for Step)

**Pre-step**: A Step-shaped action that may run before a target Step to clear interference such as ads, popups, or cross-sells. Uses an explicit Contingency condition (for example when a selector is visible). Declared at Flow level as defaults and/or per Step as overrides or additions. Pre-steps do not carry Audits or nested Pre-steps. _Avoid_: hook, middleware, guard (as product terms)

**Recording**: The in-progress capture session in Create View that produces or updates a Flow when finished. _Avoid_: Flow, Chrome JSON file (as synonyms for the session)

**Finding**: One addressable issue produced by an Audit (rule, severity, target, message, and related metadata). _Avoid_: report, violation (as the umbrella term), issue blob

**Replay**: Re-executing a Flow's recorded actions against a live browser, Chrome Recorder–style. Snapshots are not the v1 replay engine. _Avoid_: restore, snapshot replay (for v1 execution)

**Regression**: A Finding that is new or worsened relative to a chosen baseline run. _Avoid_: failure, flaky (as synonyms for Regression)

**Handoff**: The structured payload Contingency emits so an external agent can attempt a fix (Flow context, Step, Findings / Regressions). Contingency does not apply fixes itself. _Avoid_: agent run, autofix (as Contingency-owned concepts)

**Runner**: The CLI-owned engine that executes Flows into Runs. Audit View and headless invocations use this engine; they do not ship a second player. _Avoid_: player, executor (as product terms)

**Run**: One execution of a Flow that produces Findings (and Regressions when a baseline is in effect). Create View recordings are not Runs; Audit View, headless CLI, and monitoring all produce Runs via the Runner. _Avoid_: session, job (as synonyms for Run)

**Baseline**: The Run a Flow compares against to detect Regressions. Defaults to the previous Run; may be explicitly pinned to a known-good Run. _Avoid_: golden file, snapshot (as synonyms for Baseline)

**Alert**: A delivered notification about one or more Regressions (channel plus payload), typically emitted from a Run. Distinct from detecting a Regression and from emitting a Handoff. Scheduling when Runs happen (cron, CI) lives outside Contingency — there is no Monitor entity. _Avoid_: monitor, schedule, subscription (as Contingency domain objects)
