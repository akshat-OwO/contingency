# Flow skills are learned from temporary Teaching recordings

> Supersedes ADRs [0025](./0025-agent-flow-is-compiled-from-a-demonstration.md), [0028](./0028-approved-agent-flows-are-immutable-revisions.md), [0032](./0032-external-agents-receive-a-bounded-teaching-feed.md), and [0033](./0033-agent-flow-catalog-stores-versioned-evidence-packages.md). Supersedes the authoring and approval model in [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) and [ADR 0037](./0037-pending-decisions-relay-user-consent-over-mcp.md).

Contingency learns a reusable **Flow Skill** from a user-led **Teaching Recording**. The Flow Skill is the only durable authoring artifact. The Teaching Recording is temporary evidence that Contingency deletes after a successful Dry Run and explicit user verification.

The current authoring path asks an external agent to compile a typed Agent Flow draft, map action spans into Evidence Slices, obtain authorization for a Verification Run, assess each Agent Step, complete verification, and obtain approval. This path protects a governed package, but it makes teaching a journey harder than demonstrating the journey itself. A user who has already shown the work should not need to supervise a second authoring protocol.

## Workspace flow

A user starts Teaching in either of two ways:

- Run `contingency web` and create a Teaching session in the Workspace.
- Ask an external agent to open a Teaching session through MCP.

Both paths open the browser in `setup`. The user may navigate, authenticate, choose Emulation, and edit storage without creating Teaching evidence. The Workspace shows **Start recording**.

When the user starts recording, Contingency enters `recording` and captures video, Trace data, semantic browser actions, accessibility state, URL transitions, Emulation, and user Instructions. The Workspace shows a recording timer and **Stop**.

When the user stops recording, Contingency finalizes a process-independent Teaching Recording. If an external agent is waiting, Contingency wakes it. Otherwise, the Workspace identifies the ready recording so the user can ask an agent to learn it later.

The external agent analyzes the recording and writes a Flow Skill. The agent then offers a Dry Run with different inputs. A passing Dry Run lets the user verify the Flow Skill. User verification deletes the Teaching Recording.

## State model

Browser lifecycle and Teaching lifecycle are separate values. A live browser may remain open while Teaching moves through these states:

```text
setup
recording
finalizing
ready
learning
skill-drafted
dry-running
dry-run-passed
verified
failed
```

`AgentSessionPhase` continues to describe the browser session. A separate tagged `TeachingCaptureState` describes Teaching. Each state contains only the data valid for that state.

The persistent Teaching Recording uses its own lifecycle:

```text
ready
learning
skill-drafted
dry-run-passed
purge-pending
purged
failed
```

This persistent state lets `contingency web` create a recording that another MCP process learns later. It also lets cleanup resume after a process exit.

## Capture boundary

The **Start recording** control is a privacy boundary. Contingency does not capture video, Trace data, semantic actions, screenshots, or accessibility evidence before the user presses it.

Contingency cannot meet this contract by recording the whole browser session and trimming the output later. The implementation starts every Teaching capture source when the state enters `recording`. It stops every source against the same end timestamp.

The browser frame stream is the video source. A session-owned encoder receives frames only while Teaching is in `recording`. Recording does not depend on the Workspace remaining connected.

## Teaching Recording

Contingency stores each unfinished Teaching Recording under an ignored internal directory:

```text
.contingency/
|-- <flow-name>/
|   |-- SKILL.md
|   `-- references/
`-- .recordings/
    `-- <recording-id>/
        |-- manifest.json
        |-- recording.webm
        |-- trace.zip
        `-- events.jsonl
```

The recording manifest stores the capture state, the Flow Skill target, artifact hashes, timestamps, Emulation, and cleanup status. The event stream stores bounded semantic actions, accessibility targets, URL transitions, and user Instructions. Secret values are absent from agent-readable evidence.

The `.recordings` directory remains local and ignored. Flow Skill directories may be committed. The repository must stop ignoring the entire `.contingency` directory when the Flow Skill implementation lands.

## Agent access

MCP exposes bounded operations that let an agent:

- List Teaching Recordings that are ready to learn.
- Wait for a user to start or stop a recording.
- Read the semantic timeline and accessibility evidence.
- Fetch one keyframe at a time.
- Save a Flow Skill and its references atomically.
- Start a Dry Run of one saved Flow Skill.
- Report the Dry Run result.

MCP does not return the raw Trace or the whole video in one response. The agent reads the timeline first and requests visual evidence when the timeline is not enough.

## Flow Skill package

The Flow Skill lives at `.contingency/<flow-name>/SKILL.md`. It contains the inputs, preconditions, ordered work, completion criteria, branches, and observable outcome.

The learning agent uses only these authoring skills when they are available:

- `writing-for-agents`
- `technical-writing`
- `unslop`

The learning agent does not use `skill-creator`. Contingency owns the package shape and validates it before saving.

`SKILL.md` is a how-to document. It keeps the steps and the information required on every run. Conditional detail moves into a file under `references/`.

An accessibility reference records stable roles, accessible names, nearby context, relevant states, and concise selection rationale. The rationale explains why a user-visible target is more stable than a positional or generated selector. It does not store private model reasoning.

The Flow Skill does not contain short-lived element references, raw action logs, screenshots, captured secrets, or fixed values that the demonstration established as inputs.

## Dry Run and verification

A Dry Run executes the Flow Skill in a fresh browser context. It uses the saved Emulation and asks for required inputs again. When practical, the agent changes at least one demonstrated input so the Dry Run tests reuse rather than repetition.

The Dry Run passes only when the Flow Skill reaches its stated observable outcome. A passing agent result does not delete the Teaching Recording.

After a pass, the Workspace shows the Flow Skill files and the Dry Run result. The user may verify or reject the Flow Skill. Rejection keeps the Teaching Recording available for another edit and Dry Run.

User verification starts cleanup in this order:

1. Persist the final Flow Skill and its references.
2. Persist the successful Dry Run result.
3. Persist the user's verification.
4. Mark the Teaching Recording `purge-pending`.
5. Delete the video, Trace, events, keyframes, screenshots, and temporary manifests.
6. Mark the Teaching Recording `purged`.
7. Remove the empty temporary recording directory.

Startup retries every `purge-pending` cleanup. Repeated cleanup converges on the same state. A cleanup failure does not remove the verified Flow Skill. The Workspace reports the retained sensitive artifacts and offers a retry.

After cleanup, only the Flow Skill and its references remain. A verification reference may retain the time, the redacted inputs, and the observable outcome of the last successful Dry Run. It does not retain raw Teaching or Dry Run media.

## Monitoring

Flow Skills replace Agent Flow packages as the reusable instructions for future runs. Monitoring may execute a Flow Skill and store its latest assessment, but monitoring does not introduce a second authoring format.

Execution Boundary rules remain where a run can leave the saved domain scope or cause an irreversible effect. Those rules protect execution. They do not require a draft, an Evidence Slice, or a separate approval package.

## Considered options

- **Keep Agent Flows and generate a Flow Skill beside them.** Rejected because the two durable artifacts can disagree.
- **Generate a Flow Skill that wraps an Agent Flow.** Rejected because the user still pays for the existing compilation and approval path.
- **Delete the recording after any passing Dry Run.** Rejected because the user has not accepted the generated instructions yet.
- **Keep Teaching Recordings for later debugging.** Rejected as the default because the recordings contain sensitive browser activity. A future retention option requires a separate decision and an explicit user choice.
- **Store all accessibility evidence in `SKILL.md`.** Rejected because conditional lookup detail hides the procedure. The Flow Skill uses references when the detail earns another file.

## Consequences

- The Workspace gains an honest setup state and user-owned recording controls.
- `contingency web` must own Teaching sessions instead of acting only as a catalog viewer.
- Teaching Recordings must outlive their creating process until verification or explicit deletion.
- The Agent Flow compiler, Evidence Slice authoring, revision heads, Verification authorization, and approval path become obsolete after the Flow Skill path replaces them.
- The glossary, MCP tools, Workspace copy, repository ignore rules, and `verify-contingency` instructions must move to the Flow Skill vocabulary in the implementation changes.
- A failed Dry Run or rejected Flow Skill keeps the Teaching Recording so the agent can revise its work.
- A verified Flow Skill leaves no raw Teaching media behind.
