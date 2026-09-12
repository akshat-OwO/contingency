# Contingency is an agent sanity monitor

> Supersedes ADRs [0001](./0001-flow-as-chrome-recorder-json.md)–[0024](./0024-scroll-targets-a-container-and-waits-for-readiness.md), [0029](./0029-contingency-owns-the-sole-runner.md), and [0030](./0030-agent-view-is-separate-from-audit-view.md) for new work.

Contingency is an agent-driven product sanity monitor, not a deterministic Flow authoring and audit tool. Companies teach journeys through user-led browser demonstrations, compile them into Approved Agent Flows, and run them in Suites to learn whether features still work. The deterministic Flow stack — Create View Recording, Audit View, accessibility Audits, performance vitals, Gate, Regression, Baseline, and Handoff — is removed. One unified **Workspace** replaces Create View and Agent View; one MCP-owned browser is the sole runtime; Teaching, Verification Runs, Interactive Runs, and Run Summary inspection all happen there.

Teaching follows a user-led capture model inspired by screen-recording teach flows: the user performs the journey while the external agent observes. MCP browser-act tools are disabled during Teaching. Contingency records video, Trace, and structured actions locally, then runs a Contingency-owned **video-analysis pass** when Teaching ends. The pass produces a **PlayByPlay** — a prose timeline of what happened — which becomes the primary compilation input. URL transitions, page metadata, and structured captured actions cross-check the PlayByPlay; user **Instructions** attach business intent the video cannot infer, such as why an optional popup should be skipped. The **Teaching Feed** leads with the PlayByPlay and still carries Instructions, actions, snapshots, and screenshot references for evidence. The external agent compiles an Agent Flow draft; the user confirms inferred Agent Step boundaries during Verification Run before approval.

Monitoring stays outside Contingency for the first version: scheduling is external — CI or cron invokes MCP and a Suite Run — and assessment history lives in the catalog for human review. Agent Assessments do not produce automatic alerts. Native scheduled Suite Runs with webhook emission may follow later.

## Considered Options

- **Keep deterministic Flows alongside Agent Flows**: rejected because two authoring paths, two runners, and two inspection modes split the product and confuse the teach → monitor story.
- **Structured action log as primary compilation input**: rejected because asking the compiler agent to reconstruct intent from hundreds of element-ref actions is brittle; a PlayByPlay derived from video is closer to how humans describe what they did.
- **External agent runs video analysis**: rejected because every MCP client would need its own vision pipeline; Contingency-owned analysis produces consistent PlayByPlay quality and keeps MCP clients on prose, not pixels.
- **Mixed-control Teaching**: rejected in favor of user-only browser control during Teaching; the agent acts only during Verification Runs and Interactive Runs.
- **Automatic alerts on Agent Assessment changes**: rejected for the same reason as ADR 0034 — model variance is not product regression.

## Consequences

- ADRs 0001–0024, 0029, and 0030 describe the removed deterministic Flow and Audit View stack and are superseded by this decision for new work.
- ADR 0032 remains in force for Teaching Feed redaction and bounding, but the feed shape gains a leading `playByPlay` field.
- ADR 0025 remains: Agent Flows are still compiled from Demonstrations with Contingency-derived Evidence Slices; only the primary compilation signal changes.
- Create View browser tooling (Emulation, storage, devtools) ports into the unified Workspace where it still helps teaching setup.
- **Takeover** applies to Interactive Runs only, not Teaching.
