# Contingency

Contingency lets companies author and re-run website Flows that check performance and accessibility, surface Findings, and feed agent-driven fixes.

## Language

**Flow**: Contingency's primary durable artifact: Chrome DevTools Recorder–compatible JSON extended with Contingency fields (for example conditional Pre-steps and ordered Audit Steps). _Avoid_: Workflow, recording (as the saved artifact), contingency project

**Create View**: The authoring mode over a Flow: live browser on a canvas, record Steps, add Audits, and author Pre-steps. _Avoid_: Create product, editor (as the product name)

**Audit View**: The execution and inspection mode over a Flow: import or open a Flow, watch a Run, step through the Run timeline to inspect a Step's actions and Findings. It observes the CLI Runner rather than executing Flows itself. Stepping back does not rewind browser state or fork the Run. _Avoid_: calling this mode itself "an Audit"

**Audit**: A pluggable check represented as an ordered custom Step in a Flow. Running it produces Findings at that point in the Flow. The v1 check kind is accessibility. Performance is not an Audit: it is a toggle on a navigating Step, measured by the Runner at that navigation ([ADR 0008](./docs/adr/0008-performance-is-a-navigation-step-toggle.md)). _Avoid_: Audit View, axe (that is the implementation), performance audit

**Step**: One ordered unit in a Flow: either a Chrome DevTools Recorder–shaped browser action (click, fill, navigate, and so on) or a Contingency Audit custom Step. _Avoid_: semantic step, page, checkpoint (as synonyms for Step)

**Pre-step**: A browser-action-shaped Step that may run before a target Step to clear interference such as ads, popups, or cross-sells. Uses an explicit Contingency condition (for example when a selector is visible). Flow Pre-steps run before every Step after the initial navigation; per-Step Pre-steps run only before their target. Pre-steps do not carry Audits or nested Pre-steps. _Avoid_: hook, middleware, guard (as product terms)

**Recording**: The in-progress capture session in Create View that produces or updates a Flow when finished. _Avoid_: Flow, Chrome JSON file (as synonyms for the session)

**Variable**: A named value a Flow declares but does not contain, supplied to the Runner when the Flow is executed. Two independent properties: `secret` means the value is redacted from the persisted Run; `runtime` means the Runner may prompt for it when no value was supplied and the terminal is interactive. A 2FA code is both; a target environment URL is neither. _Avoid_: Secret Variable (superseded), environment variable, captured secret, redacted value

**Finding**: One addressable issue produced by an Audit (rule, severity, target, message, and related metadata). _Avoid_: report, violation (as the umbrella term), issue blob

**Replay**: Re-executing a Flow's recorded actions against a live browser, Chrome Recorder–style. Snapshots are not the v1 replay engine. _Avoid_: restore, snapshot replay (for v1 execution)

**Regression**: A Finding that is new or worsened relative to a chosen baseline run. _Avoid_: failure, flaky (as synonyms for Regression)

**Handoff**: The structured payload Contingency emits so an external agent can attempt a fix (Flow context, Step, Findings / Regressions). Contingency does not apply fixes itself. _Avoid_: agent run, autofix (as Contingency-owned concepts)

**Runner**: The CLI-owned engine that executes Flows into Runs. Audit View and headless invocations use this engine; they do not ship a second player. _Avoid_: player, executor (as product terms)

**Run**: One execution of a Flow that produces Findings (and Regressions when a baseline is in effect). Create View recordings are not Runs; Audit View, headless CLI, and monitoring all produce Runs via the Runner. _Avoid_: session, job (as synonyms for Run)

**Baseline**: The Run a Flow compares against to detect Regressions. Defaults to the previous Run; may be explicitly pinned to a known-good Run. _Avoid_: golden file, snapshot (as synonyms for Baseline)

**Alert**: A delivered notification about one or more Regressions (channel plus payload), typically emitted from a Run. Distinct from detecting a Regression and from emitting a Handoff. Scheduling when Runs happen (cron, CI) lives outside Contingency — there is no Monitor entity. _Avoid_: monitor, schedule, subscription (as Contingency domain objects)
