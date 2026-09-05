# Future: Agent Flow

Vocabulary: [`CONTEXT.md`](../../CONTEXT.md). Decisions: [`docs/adr/`](../adr/). Product sequence: [`product-path.md`](./product-path.md).

The design is settled. Implementation has not started. The first milestone proves one Agent Flow end to end; Suite orchestration follows immediately afterward.

## Problem

After a risky change such as a major React upgrade, a company needs to exercise important user journeys across its business areas and inspect what still works. Deterministic Flows remain useful for repeatable audits, but they encode one browser action path. An agent should instead learn a demonstrated journey, adapt its actions to the current website, report what it observed, and ask for help when human input or judgment is required.

## Product boundary

An **Agent Flow** is separate from a deterministic **Flow**. It is a versioned, schema-validated evidence package compiled by an external agent from a user-guided **Demonstration** ([ADR 0025](../adr/0025-agent-flow-is-compiled-from-a-demonstration.md)).

The external agent owns reasoning and its private to-do list. Contingency owns browser effects, lifecycle, schema validation, persistence, the Execution Boundary, Trace and video capture, and Run history. The CLI, MCP server, and web interfaces are adapters over one Contingency-owned Runner ([ADR 0029](../adr/0029-contingency-owns-the-sole-runner.md)).

## End-to-end journey

```text
User asks for a sanity journey
    ↓
Agent searches the selected Agent Flow Catalog
    ├─ approved match → start Interactive Run
    ├─ draft match → offer to continue or revise it
    └─ no match → ask the user to teach the journey
                         ↓
                    Teaching
                         ↓
                 Demonstration
                         ↓ bounded Teaching Feed
                  agent compiles draft
                         ↓
              user reviews in Agent View
                         ↓ authorize once
                 Verification Run
                         ↓ successful
                    user approves
                         ↓
                Approved Agent Flow
```

## Artifact model

### Demonstration

Teaching is mixed-control. The user may act directly, tell the agent what to do, or mark a field for private input. Contingency records the actor, browser actions, Browser Snapshots, screenshots, URL transitions, timing, and the full Trace. Known entered secrets become Variable references rather than Agent Flow literals.

The external agent receives a bounded **Teaching Feed**, not the raw Trace ([ADR 0032](../adr/0032-external-agents-receive-a-bounded-teaching-feed.md)). The feed excludes cookies, authorization headers, network bodies, the full video, and the full Trace. Screenshots travel as references whose bytes the agent fetches one at a time, so the feed stays small enough to read. They mask known sensitive fields, but visible page content can still be sensitive, so Agent View discloses that the feed is sent to the selected agent.

### Agent Flow Revision

An Agent Flow has a stable identity across immutable revisions. Each revision is a directory package containing:

- a schema-versioned manifest;
- title and short description;
- optional search tags;
- Domain Scope and Emulation;
- Variable declarations;
- ordered, linear Agent Steps;
- Confirmation Step markers;
- content-addressed Evidence Slice files.

The agent proposes objective-level Step spans, names, and descriptions. The user may merge, split, rename, or clarify them before verification. Contingency derives standardized Evidence Slices from the selected Demonstration spans; the agent cannot invent evidence. Invalid compiler output receives structured errors and never enters the catalog.

Approved revisions are immutable. Editing one creates a draft while the approved revision remains usable. Catalog writes use optimistic concurrency and never auto-merge Agent Steps, domains, Variables, confirmation markers, or evidence ([ADR 0028](../adr/0028-approved-agent-flows-are-immutable-revisions.md)).

## MCP control

One local MCP server process runs per agent client ([ADR 0026](../adr/0026-external-agents-control-agent-flows-through-mcp.md)). It exposes session-scoped tools in these groups:

- catalog selection, search, draft creation, revision, archive, and confirmed deletion;
- Agent Session creation, inspection, interruption, and closure;
- Teaching start, mixed-control capture, feed retrieval, and compilation validation;
- Browser Snapshot and screenshot observation;
- scoped browser navigation, input, and page actions;
- Takeover request and control-state inspection;
- Verification Run request and state inspection;
- Agent Assessment submission with evidence references;
- Run completion, Run Summary, and read-only Run opening.

Every mutating call carries an operation id. Repeating an operation id returns its recorded result instead of executing the mutation again. This applies to browser actions as well as catalog writes.

The MCP client name and version are stored automatically. Provider or model metadata is stored when the client supplies it and is marked unverified.

## Agent Session and Agent View

An **Agent Session** is an ephemeral envelope binding one MCP process, external agent, browser, and **Agent View** to at most one active Teaching or Run activity. Effect scopes acquire and release every browser, context, page, stream, temporary file, and lock. Normal completion, failure, interruption, `SIGINT`, and `SIGTERM` finalize available artifacts and release resources. Startup removes only stale temporary resources carrying a dead process's ownership marker.

The MCP start tool returns `http://127.0.0.1:<port>/agent?session=<id>`. The session id selects a session and is not an authentication token. The server binds only to loopback, rejects cross-origin mutations and WebSockets, and does not enable permissive CORS. The dropdown shows only sessions owned by that MCP process.

Agent View is separate from Audit View ([ADR 0030](../adr/0030-agent-view-is-separate-from-audit-view.md)). It shows:

- the live browser stream;
- the active Agent Step;
- recorded browser actions;
- current controller and Takeover requests;
- Agent Step summaries and assessments reported through MCP;
- the final Run Summary and embedded local video.

Agent View may close without pausing the Run. The agent can return the same link again. After the MCP process exits, `open_run` starts a new read-only local viewer for a persisted Run Summary.

## Control and safety

The agent generates its own plan and controls reversible browser actions. Contingency does not require that plan to replay the Demonstration's action path, but it enforces a user-approved **Execution Boundary** ([ADR 0027](../adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).

- Teaching proposes exact hosts and explicit wildcard patterns. The user approves the Domain Scope. A new domain pauses the Run.
- The user marks irreversible or high-impact objectives as Confirmation Steps.
- Confirmation authorizes one specific irreversible action attempt. A retry requires fresh confirmation.
- A new objective outside the approved Agent Steps pauses for confirmation.
- Agent and user control are exclusive. User Takeover interrupts the in-flight Effect and has priority, but it cannot undo an action already dispatched to the browser.
- Recording continues during Takeover. Sensitive values become Variable references.
- Agent View alone authorizes one Verification Run and final Agent Flow approval. The external agent may request those actions but cannot invoke them.

The design intentionally trusts the model to plan within that boundary. Video provides evidence after an action and is not a preventive control.

## Verification and approval

Agent View presents the draft's Agent Steps, Variables, Domain Scope, and Confirmation Steps. The user may authorize exactly one Verification Run for that exact draft.

Verification uses a fresh browser context with the declared Emulation and Variables supplied again. Confirmation Steps still require confirmation. If verification fails, the agent may use its evidence to compile a changed draft, but the user must authorize another Verification Run. A successful verification enables a separate user-only approval control.

## Interactive Run semantics

The Runner processes Agent Steps in declared order. The external agent may retry ordinary observations and reversible actions within configurable Step and Run ceilings. Every attempt remains in the Trace and action timeline.

After each Agent Step, the agent submits an evidence-backed assessment:

- `working`
- `not-working`
- `inconclusive`
- `blocked`

Only `working` advances to the next Agent Step. Any other assessment stops the Agent Flow, leaves later Steps unexecuted, and marks coverage incomplete. A hard ceiling records a separate `timed-out` execution outcome and never fabricates an Agent Assessment.

The Run Summary reports assessment counts separately from coverage. It embeds the full Run video locally. Sending that sensitive video outside Contingency requires explicit user confirmation. Agent Assessments remain available in history but do not produce automatic Regressions or Alerts ([ADR 0034](../adr/0034-agent-assessments-do-not-create-regressions.md)).

## Catalog and retention

The explicitly selected **Catalog Root** defaults to the workspace's `.contingency` directory. The agent never scans a user-global catalog implicitly. Catalog search supports deterministic filters and local full-text search over title, description, tags, and Agent Step descriptions ([ADR 0033](../adr/0033-agent-flow-catalog-stores-versioned-evidence-packages.md)).

Before Teaching, the agent searches for close matches and asks whether to run an approved revision, revise an existing Agent Flow, or create a distinct one. Archive is the default removal operation; permanent deletion requires direct confirmation.

Artifact retention is configurable per Catalog Root. By default, approval deletes the full Demonstration Trace and video while preserving Evidence Slices and verification evidence.

## Suites

A **Suite** is a named, ordered manifest of Approved Agent Flows defining the required sanity coverage for one business area. Suites run members sequentially.

A Suite may declare one **Suite Setup**, usually login ([ADR 0031](../adr/0031-suite-setup-seeds-isolated-member-contexts.md)). The Runner executes setup once, holds the resulting browser storage state in memory, and seeds a fresh context for each member. Setup state is discarded when the Suite Run ends. Failed or inconclusive setup stops member execution and leaves coverage incomplete.

After a member fails, the agent asks the user whether to retry it in a fresh context, continue, or stop. It never invents missing coverage. A missing approved Agent Flow becomes a Teaching request.

## Implementation sequence

### Milestone 1: one Agent Flow end to end

1. **Protocol and package schema**
   - Add Agent Flow, Agent Step, Evidence Slice, revision, assessment, execution-outcome, and Agent Session schemas.
   - Add schema versioning, validation diagnostics, operation ids, and optimistic-concurrency inputs.
   - Add fixture packages and migration tests before persistence code.

2. **Catalog services**
   - Implement Catalog Root selection, directory package storage, content hashing, revision heads, archive, retention, deterministic filters, and full-text search.
   - Keep invalid compiler output and unapproved drafts out of approved search results.

3. **Runner boundary and Agent Session**
   - Move the existing CLI-owned Runner boundary to shared Contingency services.
   - Add agent-controlled Run state, ordered Agent Step enforcement, ceilings, idempotent mutations, scoped cleanup, and stale-owner startup cleanup.

4. **MCP server and browser tools**
   - Add one local server process per client.
   - Expose session-scoped lifecycle, Browser Snapshot, screenshot, browser action, Variable, Takeover, assessment, and Run Summary tools.
   - Keep Playwright private to Runner services.

5. **Agent View**
   - Add `/agent?session=<id>`, the session dropdown, live stream, action timeline, active Step, controller state, Takeover, draft review, verification authorization, approval, and read-only summary mode.
   - Enforce loopback binding and browser-origin checks.

6. **Teaching and compilation**
   - Capture mixed user and agent actions with actor identity.
   - Build the bounded Teaching Feed and standardized Evidence Slice derivation.
   - Validate compiler output, support user Step corrections, and persist a draft revision.

7. **Verification and approved execution**
   - Run exact-draft verification in a fresh context.
   - Require per-attempt Confirmation Step approval.
   - Approve only through Agent View, then search and execute the Approved Agent Flow in a new Interactive Run.
   - Produce structured assessments, coverage, Trace, video, attribution, and Run Summary.

The milestone is complete when a user can teach one login journey, inspect and verify the generated Agent Flow, approve it, start a later agent conversation, find the approved Agent Flow, run it against a fresh browser context, intervene through Agent View, and inspect the final evidence.

### Milestone 2: company sanity Suites

1. Add Suite manifests and ordered member search.
2. Add Suite Setup and in-memory storage-state seeding into isolated member contexts.
3. Add sequential execution, setup failure handling, member failure choices, and Suite coverage summaries.
4. Exercise the original target scenario: select the company's vertical Suites after a major framework upgrade and report working, not-working, inconclusive, blocked, unexecuted, and timed-out coverage with local evidence.

## Explicitly outside the first milestone

- unattended or CI agent-controlled Runs;
- shared or remote MCP daemons;
- hosted Agent Flow catalogs;
- parallel Suite members or one-agent-per-member execution;
- vector search;
- automatic Regressions or Alerts from Agent Assessments;
- raw Playwright or CDP access through MCP;
- automatic upload of videos, Traces, or Teaching artifacts;
- durable browser profiles or resumable work after an uncatchable process death.
