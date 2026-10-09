# Writing and fixing tests

A test is **deterministic**: it gives the same verdict on a fast laptop and on a starved CI runner. CI runners are several times slower than a development machine, and every timing assumption that holds locally is a coin flip there. Every rule below serves that one property.

## Waiting

Every wait waits on the **event** the next assertion reads.

- **Unit and service tests** run on virtual time: `it.effect` provides `TestClock`, and `TestClock.adjust` moves it (see `packages/cli/tests/services/mcp-channel.test.ts`). When the code under test polls or debounces, inject the interval or the `Clock` so the test controls it.
- **Integration tests** wait for a signal the code emits: a `Deferred`, a stream event, a page event, or a state read that reports the very condition the test asserts next. When the product exposes no such signal, add one to the product; it is a seam other callers need too.
- **One hang guard per wait**: a single `Effect.timeout` sized for a hung process (tens of seconds), never tuned to how long the work usually takes. It turns a hang into a fast, named failure; it is not part of the test's logic.

The `contingency/no-test-wait` lint rule (`packages/lint-rules`) enforces this in test files: real-time sleeps, delays, timers, and spaced schedules fail lint. Files predating the rule sit on a legacy list in `oxlint.config.ts`; that list only shrinks.

## Asserting

Assert outcomes: states, events, artifacts, and values. A duration, a frame count from real-time capture, or `Date.now()` arithmetic varies with machine load, so it measures the runner rather than the code.

## Fixing a flaky test

A flaky test is a race, in the test or in the product; it is often a real product bug that users on slow machines hit too.

1. **Reproduce it deterministically.** Make the slow path happen on purpose: stall the page (`browser-storage-checks.integration.test.ts` patches `Storage.prototype.getItem`), hold a `Deferred`, or delay a fake server until the test releases it. The test goes **red** on every run before the fix.
2. **Fix the race** where it lives, then watch the same test go green.
3. **Keep the reproduction** as the regression test.

The fix for a CI timing failure is the race, found and removed. A larger timeout, more attempts, or a retry hides the race until the runner gets slower again.

## Before opening a PR

Run each new or changed integration test file five times in a row; all five pass.
