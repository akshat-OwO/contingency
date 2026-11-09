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

on its matrix row or site entry. The suite expects the limitation, so fixing it fails the suite until the row drops its `gap`. Never delete a failing row to make a suite pass.

To add native trees, run `vpx .cursor/skills/verify-contingency/bin/native-snapshot-capture.mjs ios` or `android --apk <fixture.apk>`. Each run boots one proof-owned simulator or emulator and removes it. Commit the JSON files under `tests/fixtures/native-snapshots/`; they contain no input values.

To record sites, add entries to `tests/integration/site-corpus/sites.json` and run `SITE_CORPUS_ROOT=<dir> vpx packages/cli/tests/integration/site-corpus/record.ts --only <id>`. Recording reaches the live network; replay never does. The corpus is not committed. A site that records a bot challenge or no exchanges does not belong in the list.
