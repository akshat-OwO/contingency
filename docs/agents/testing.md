# Writing and fixing tests

A test is **deterministic**: it gives the same verdict on a fast laptop and on a starved CI runner. CI runners are several times slower than a development machine, and every timing assumption that holds locally is a coin flip there. Every rule below serves that one property.

## Waiting

Every wait waits on the **event** the next assertion reads.

- **Unit and service tests** run on virtual time: `it.effect` provides `TestClock`, and `TestClock.adjust` moves it (see `packages/cli/tests/services/mcp-channel.test.ts`). When the code under test polls or debounces, inject the interval or the `Clock` so the test controls it.
- **Integration tests** wait for a signal the code emits: a `Deferred`, a product `Stream` or `PubSub`, a fixture request (`awaitRequest`), a page event, or a session long-poll (`awaitSession`). When the product exposes no such signal, add one to the product; it is a seam other callers need too.
- **One hang guard per wait**: a single `Effect.timeout` sized for a hung process (tens of seconds), never tuned to how long the work usually takes. It turns a hang into a fast, named failure; it is not part of the test's logic.

`vp exec turbo run quality` enforces this in `**/*.test.ts`, `**/*.test.tsx`, and helpers under `tests/`. The `contingency/no-test-wait` rule in `packages/lint-rules` rejects sleeps, delay helpers, timers, Playwright `waitForTimeout`, and timed schedules. Oxlint's `no-restricted-imports` rejects timer imports, including aliases.

For a justified timer, add a rule-specific disable comment explaining the observable behavior it proves. For virtual waits, explain how the call receives `TestClock`. For a browser fixture timer, explain the page behavior it models; assertions still wait on an event.

A busy loop (`Effect.yieldNow`, `Schedule.recurs`, or a `setImmediate` poll) is not a wait on an event, even though the lint rule cannot detect it.

## Asserting

Assert outcomes: states, events, artifacts, and values. A duration, a frame count from real-time capture, or `Date.now()` arithmetic varies with machine load, so it measures the runner rather than the code.

## Fixing a flaky test

A flaky test is a race, in the test or in the product; it is often a real product bug that users on slow machines hit too.

1. **Reproduce it deterministically.** Make the slow path happen on purpose: stall the page (`browser-storage-checks.integration.test.ts` patches `Storage.prototype.getItem`), hold a `Deferred`, or delay a fake server until the test releases it. The test goes **red** on every run before the fix.
2. **Fix the race** where it lives, then watch the same test go green.
3. **Keep the reproduction** as the regression test.

The fix for a CI timing failure is the race, found and removed. A larger timeout, more attempts, or a retry hides the race until the runner gets slower again.

## Before opening a PR

Run quality and the affected tests. Every wait must observe an event or use virtual time, as enforced by the test wait lint. Keep any timer exception local and explain it in its disable comment.

Repeating a test locally can help investigate a race. Repeats are optional and do not replace a deterministic regression test.

## The Scripted Agent

Integration tests act as the external agent through the Scripted Agent in `packages/cli/tests/integration/scripted-agent.ts`, and as the person in the Workspace through `User` in `scripted-user.ts`. Use them instead of calling `Toolkit.handle` or writing a click, typing, or MCP call helper in a test file.

A journey is an Effect. Each step names an operation and its input, and the driver renders it on one of two adapters:

- **In-process**, the default, runs the operation through the agent's toolkits and reads the answer as MCP encodes and compacts it.
- **HTTP** renders the step as one `agent_code_execute` program, sent to an MCP server over the same process. A step aimed at a control carries its role and name, and the program finds the ref in its own Browser Snapshot.

Register a journey with `journey(name, { demo, singleTool, timeout, transcript }, effect)`. Every journey runs in-process. A `singleTool: true` journey also runs over HTTP and is tagged `@single-tool`, so `vitest -t @single-tool` selects the journeys that prove the single tool. Build its process with `scriptedProcess(root)`, and build it again to restart the process. A `demo: true` journey calls the demo store's operations, such as `agent_example_run_start`, so it runs only over HTTP, on a process built with `scriptedProcess(root, { demo: true })`.

| Step | What it does |
| --- | --- |
| `call(operation, params)` | Calls one operation and mints an operation id the operation takes when `params` omits it. The value is the tool's success as the agent reads it. |
| `act(sessionId, { role, name }, action)` | Acts on the control with that role and accessible name: an exact name first, then one that contains it. |
| `enterVariable(sessionId, { role, name }, variable)` | Enters a runtime Variable into the named control. |
| `awaitSession(sessionId, until)` | Long-polls Session Events until `until` holds, under one hang guard. |
| `startTeaching(params)` | Starts a Teaching session and hands it to the user. |
| `User.click`, `User.type`, `User.startRecording`, `User.stopRecording`, `User.takeover`, `User.returnControl`, `User.supplyVariable` | What the person does in the Workspace, through the same Agent Session. |

A refused operation fails with its `ToolFailure`, so assert on it with `Effect.flip`. The agent reads only the code, the message, and the Failure Reference, never the cause. When an operation leaves a session it had not seen waiting on the user, the program ends before it can answer, as a Dry Run that requests a secret Variable does. The driver then fails with the code `intervention`, which is the driver's and not Contingency's, and with the session and its reasons. Read the session with `agent_session_get` and act as the user.

A test that opens its own MCP session, such as a server with the demo store or a child process over stdio, calls the single tool through `mcpProgram(request)`. Its `call` raises a refusal as a `ToolFailure`, and `execute` answers with how a program ended. `rawMcpSession` in `tests/helpers/mcp-http.ts` opens a session without the client's headers.

### Transcripts

A journey with a `transcript` name records its HTTP run to `packages/cli/tests/fixtures/transcripts/<name>.json`. The run rewrites the file only when `RECORD_TRANSCRIPTS=1` is set; nothing else writes it. Re-record after a change to the driver or to an operation the journey calls, from `packages/cli`:

```sh
RECORD_TRANSCRIPTS=1 vp exec vitest run --config vitest.integration.config.ts tests/integration/flow-delivery.integration.test.ts -t http
```

Then run `scripted-agent.integration.test.ts`, which replays the committed transcript over HTTP. `replayTranscript(transcript, { environment, root })` replays one against fresh processes. Each program must end with the same outcome it was recorded with.

A transcript is JSON that the `Transcript` schema in `tests/integration/transcript.ts` validates. Its format is stable, and a breaking change raises `schemaVersion`.

| Field | Holds |
| --- | --- |
| `schemaVersion` | `1`. |
| `journey` | The transcript's name. |
| `steps` | In order: `process` starts a new MCP process over the same Catalog Root; `program` holds the `code` sent to `agent_code_execute` and its `outcome`; `user` holds one `action` by the person. |
| `outcome` | `status`, the `failureCode` of the operation failure the program ended with or `null`, and the receipts that did not succeed. |
| `bindings` | Each `{{token}}` in the programs and actions, and where a replay takes its value: `step` names an earlier step's `value` or `intervention` path, the earliest step that held the value; `environment` names a value the replaying test supplies, such as the fixture origin. |

Values a process mints, such as session, Flow, and Run ids and cursors, are written as tokens. Operation ids are the agent's own, so they are written as sent. A value the user supplies for a Variable is the user's, so each supply is written as its own environment token, `{{supplied1}}`, `{{supplied2}}` and so on in order, and the replaying test supplies the values. A later program or action that repeats a supplied value sends its token too. Redaction leaves only the fields in `EXEMPT_PATHS` in `transcript.ts` as written: identifiers the server validates and no answer mints, such as `_tag`, a Variable or Flow `name`, `inputs[].name`, and `action.type`, and the operation ids the agent mints. A value an earlier answer minted, such as a Snapshot continuation cursor, is bound to that answer first. Every other field is payload and is redacted, so a new free-text field needs no listing. An id or cursor is bound whole or kept as sent. A transcript holds only what the agent sent and the outcome it read: programs, failure codes, and receipts. It never holds a failure's cause.

### Emulated model

`tests/integration/claude-code-emulated.integration.test.ts` runs a real Claude Code against the AI service of `emulate`, pinned in `packages/cli` ([ADR 0090](../adr/0090-verification-may-emulate-the-model-behind-a-real-agent-harness.md)). It skips when `claude` is not on PATH and needs the built CLI. Run it through verify-contingency's `emulated-claude-code.mjs`, which builds first.

The emulated model plays `demo-interactive-run.json`, recorded by `demo-interactive-run.integration.test.ts`. Claude Code's base URL is a gate in the test that records every request. Before it forwards a main-loop request to the emulator, it replaces the emulator's rules with the next reply: read getting-started, then the next program with its tokens resolved by `resolveTokens` from the answers Claude Code sent back, then a final message. Emulate replies only as written, so the gate binds the tokens. Re-record the transcript with:

```sh
RECORD_TRANSCRIPTS=1 vp exec vitest run --config vitest.integration.config.ts tests/integration/demo-interactive-run.integration.test.ts
```

### Corpus-backed fake native device

`packages/cli/tests/helpers/corpus-native-device.ts` builds a test-only `NativeAppRuntimeBackend` from the committed accessibility trees under `tests/fixtures/native-snapshots/{android,ios}` and a scripted screen graph (`start` capture and `{ from, on: { role, name, action }, to }` transitions). Loading fails by name if a transition's control is absent from its capture. Each capture maps nodes through the real `androidNodeInteraction` / `androidNodeName` (or iOS equivalents), mints `@eN~sGENERATION` targets, refuses stale generations as the real backend does, synthesizes a PNG of the capture's viewport size, and can inject `capture_incomplete` failures to exercise Capture Gap settling and repair ([ADR 0084](../adr/0084-native-runs-repair-transient-capture-gaps.md)). Pass `androidWorkspace` or `iosWorkspace` to `agentProcessLayer`, `scriptedProcess`, or `servingMcpHttp` to drive native sessions through the Scripted Agent and MCP HTTP.

**What it does not prove:** real emulator or simulator behavior, `agent-device` client or daemon transport, ADB, `simctl`, iOS HID input, device display streams or framebuffers, or Run video and keyframe capture (screenshots are synthesized blank PNGs). Changes to any of those still require real-device verification or an explicit evidence gap in the PR.

## Coverage corpora

Three suites test Contingency against the range of interfaces real sites and apps use. Each one is deterministic.

| Suite | What it replays | Runs |
| --- | --- | --- |
| `tests/services/native-snapshot-corpus.test.ts` | Raw iOS and Android accessibility trees from the native widget corpus apps and the apps that ship with the simulator and emulator | Unit suite, no device |
| `tests/integration/web-feature-matrix.integration.test.ts` | One Teaching click per web-platform pattern in `fixtures/web-matrix.html`: shadow roots, frames, ARIA widgets, overlays, canvas | Integration suite |
| `tests/integration/site-corpus.integration.test.ts` | Recorded real sites, served offline by the site corpus proxy | Locally, when `SITE_CORPUS_ROOT` names a corpus. CI never sets it, so CI skips the suite to keep its run time down. |

### When to run them

Run the suite that matches each area your change touches, from `packages/cli`, before you open a PR. CI runs the first two on every PR, but a failure found locally is cheaper than one found in CI.

| When the change touches | Run |
| --- | --- |
| `ios-observation`, `android-observation`, `native-app-hit-test`, or an iOS or Android runtime or workspace service | `vp exec vitest run tests/services/native-snapshot-corpus.test.ts` |
| `agent-browser.ts` (Snapshot reading, hit testing, naming), Teaching click capture, or user input handling in `agent-session.ts` | `vp exec vitest run --config vitest.integration.config.ts tests/integration/web-feature-matrix.integration.test.ts`, then `site-corpus.integration.test.ts` with `SITE_CORPUS_ROOT` set if this machine has a corpus |
| A fix for a pinned `gap` | The suite that pins it. Remove the row's `gap` in the same change; the suite fails until you do. |
| A new native widget pattern, a new iOS or Android version, or an `agent-device` upgrade | Recapture with `native-snapshot-capture.mjs`, run the native suite, and commit the changed trees. Review the tree diff: a control that loses its name or clickability is a regression. |
| A release | Re-record the site corpus and run the replay suite, so drift on live sites shows up before users meet it. |

A change that touches none of these areas does not need them. If a suite applies but cannot run here (no simulator, no corpus), say so in the PR as an evidence gap rather than skipping it silently.

A known limitation is pinned as a `gap` on its matrix row or site entry. The suite expects the limitation, so fixing it fails the suite until the row drops its `gap`. Never delete a failing row to make a suite pass.

To add native trees, run `vpx .cursor/skills/verify-contingency/bin/native-snapshot-capture.mjs ios` or `android --apk <fixture.apk>`. Each run boots one proof-owned simulator or emulator and removes it. Commit the JSON files under `tests/fixtures/native-snapshots/`; they contain no input values.

To record sites, add entries to `tests/integration/site-corpus/sites.json` and run `SITE_CORPUS_ROOT=<dir> vpx packages/cli/tests/integration/site-corpus/record.ts --only <id>`. Recording reaches the live network; replay never does. The corpus is not committed. A site that records a bot challenge or no exchanges does not belong in the list.
