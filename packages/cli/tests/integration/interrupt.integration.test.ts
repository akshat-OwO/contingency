import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import type { RunVideoManifest } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem } from "effect";
import type { Scope } from "effect/Scope";

import {
  canRecordVideo,
  fixtureServer,
  IntegrationLive,
  NEVER_ANSWERED,
  STEP_BEACON,
} from "./harness";

/** Bounds failure only; readiness is waited for, never assumed. */
const READY_TIMEOUT = Duration.seconds(60);

const READY_POLL = Duration.millis(250);

/**
 * What a Ctrl-C is allowed to take. Generous next to the fifth of a second it
 * costs now, and far short of the half-minute it cost before.
 */
const INTERRUPT_BUDGET = Duration.seconds(20);

/** How long the interrupted Run gets to flush before the test gives up. */
const EXIT_TIMEOUT = Duration.seconds(90);

/**
 * How long after the first Ctrl-C the reflexive second one lands. Comfortably
 * inside the handler's 500ms window, and while the flush a single press would
 * have completed is still running.
 */
const REFLEX_GAP = Duration.millis(100);

/**
 * The CLI as a user runs it, owned by the test's scope.
 *
 * Scope-owned because every way this test can go wrong leaves a browser
 * driving itself otherwise: a readiness assertion that fails, an exit that
 * never comes. A leaked CLI outlives the worker that spawned it.
 */
const start = (
  flowPath: string,
  outputDirectory: string
): Effect.Effect<ChildProcess, never, Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      spawn(
        process.execPath,
        [
          path.join(import.meta.dirname, "..", "..", "src", "index.ts"),
          "run",
          flowPath,
          "--output",
          outputDirectory,
          "--video",
          "--retry",
          "0",
        ],
        { stdio: "ignore" }
      )
    ),
    (child) =>
      Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      })
  );

/**
 * Poll until something is observably true, reporting whether it ever became
 * true. A test that quietly gave up waiting and carried on would fail later
 * for a reason that has nothing to do with what it is checking.
 */
const waitUntil = (ready: () => boolean): Effect.Effect<boolean> =>
  Effect.gen(function* poll() {
    for (;;) {
      if (ready()) {
        return true;
      }
      yield* Effect.sleep(READY_POLL);
    }
  }).pipe(
    Effect.timeoutOption(READY_TIMEOUT),
    Effect.map((arrived) => arrived._tag === "Some")
  );

const readdirSafe = (directory: string): readonly string[] => {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
};

/** The recording this Run has begun writing, once there is one. */
const recordingOf = (runs: string): string | undefined => {
  const [flowDirectory] = readdirSafe(runs);
  if (flowDirectory === undefined) {
    return;
  }
  const [runDirectory] = readdirSafe(path.join(runs, flowDirectory));
  if (runDirectory === undefined) {
    return;
  }
  const artifacts = path.join(runs, flowDirectory, runDirectory);
  return existsSync(path.join(artifacts, "attempt-1.webm"))
    ? artifacts
    : undefined;
};

const waitForExit = (child: ChildProcess): Effect.Effect<null> =>
  // `null` rather than nothing: the formatter rewrites an explicit `undefined`
  // here into a call that does not typecheck.
  Effect.callback<null>((resume) => {
    child.on("exit", () => {
      resume(Effect.succeed(null));
    });
  });

/**
 * A Flow that is still working long after its page has loaded normally.
 *
 * Interrupting mid-navigation is a different case: the browser tool runs one
 * command at a time per session, so a flush requested then waits for that
 * navigation's own timeout and the Run gives up on the file instead of holding
 * the terminal. That limitation is recorded in ADR 0010; what these tests
 * protect is the Run a user actually interrupts.
 */
const writeLongRunningFlow = (
  directory: string,
  fixtures: { readonly url: (file: string) => string }
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* writeFlow() {
    const fileSystem = yield* FileSystem.FileSystem;
    const flowPath = path.join(directory, "flow.json");
    yield* fileSystem
      .writeFileString(
        flowPath,
        JSON.stringify({
          steps: [
            { type: "navigate", url: fixtures.url("checkout.html") },
            ...Array.from({ length: 3000 }, (_unused, index) => ({
              selectors: [["#name"]],
              type: "change",
              value: `Ada ${index}`,
            })),
          ],
          title: "Interrupted",
        })
      )
      .pipe(Effect.orDie);
    return flowPath;
  });

/**
 * The bundled recorder polls screenshots and can wedge its finalize across a
 * mid-recording navigation, making `record stop` miss the Run's five-second
 * flush ceiling (ADR 0010). The recording is lost to that upstream defect,
 * not to the shutdown path under test, so these tests retry: every attempt
 * still asserts strictly.
 */
const WEDGE_RETRIES = 2;

it.live.skipIf(!canRecordVideo())(
  "leaves a flushed recording when a Run is interrupted",
  () =>
    Effect.gen(function* interruptedRun() {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtures = yield* fixtureServer;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-interrupt-",
      });

      const flowPath = yield* writeLongRunningFlow(directory, fixtures);
      const runs = path.join(directory, "runs");
      const child = yield* start(flowPath, runs);

      // Wait for the Run to be observably where the test needs it, rather than
      // for a duration that happens to be long enough on this machine. A
      // recording on disk means the browser launched, the page loaded, and
      // capture began — which is the state a Ctrl-C has to survive.
      const reached = yield* waitUntil(() =>
        // The page beacons when a Step types into it, which cannot happen
        // until the Flow's own opening navigation has returned. Request
        // arrival and the recording file are both true earlier than that —
        // the file is created empty when capture starts — so a signal sent on
        // either can land mid-navigation, where the flush is deliberately
        // abandoned and this test would fail without a regression.
        fixtures.requests.includes(STEP_BEACON)
      );
      expect(reached).toBe(true);

      const signalledAt = Date.now();
      child.kill("SIGINT");
      yield* waitForExit(child).pipe(Effect.timeout(EXIT_TIMEOUT));
      const tookMs = Date.now() - signalledAt;

      // Ctrl-C has to feel like Ctrl-C. A Run is torn down uninterruptibly, so
      // anything slow in teardown is time the terminal spends ignoring the
      // user: closing a browser with a navigation still in flight took 27
      // seconds until the load was stopped first.
      expect(tookMs).toBeLessThan(Duration.toMillis(INTERRUPT_BUDGET));

      // An unflushed recording is a lost recording, and the Runs whose video
      // matters most are exactly the ones that never reach a tidy end. This is
      // asserted unconditionally: a test that also accepts a missing file
      // stops protecting the behaviour it is named after.
      const artifacts = recordingOf(runs) ?? "";
      const recording = yield* fileSystem.readFile(
        path.join(artifacts, "attempt-1.webm")
      );
      expect(recording.length).toBeGreaterThan(1024);

      // And a recording nobody can attribute to a Run is very nearly a lost
      // one, so the manifest is written on every exit path too.
      const manifest = JSON.parse(
        yield* fileSystem.readFileString(path.join(artifacts, "video.json"))
      ) as RunVideoManifest;
      expect(manifest.segments).toHaveLength(1);
      expect(manifest.segments[0]?.recorded).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive)), {
      retry: WEDGE_RETRIES,
    }
);

/**
 * The reflex window is the one branch of the signal handler no other test
 * reaches: every interrupt test sends exactly one SIGINT, so reverting to
 * counter semantics — or inverting the window comparison — would pass the
 * whole suite while costing a real user the recording.
 */
it.live.skipIf(!canRecordVideo())(
  "keeps the flushed recording when the second Ctrl-C is a reflex",
  () =>
    Effect.gen(function* doubleTappedRun() {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtures = yield* fixtureServer;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-double-tap-",
      });

      const flowPath = yield* writeLongRunningFlow(directory, fixtures);
      const runs = path.join(directory, "runs");
      const child = yield* start(flowPath, runs);

      const reached = yield* waitUntil(() =>
        fixtures.requests.includes(STEP_BEACON)
      );
      expect(reached).toBe(true);

      const signalledAt = Date.now();
      child.kill("SIGINT");
      // Inside the handler's reflex window, and while the flush that a single
      // press would have completed is still running. A user pressing twice out
      // of habit is not asking to lose the recording.
      yield* Effect.sleep(REFLEX_GAP);
      child.kill("SIGINT");
      yield* waitForExit(child).pipe(Effect.timeout(EXIT_TIMEOUT));

      // Swallowing the second press must not cost promptness either: the first
      // signal's shutdown carries on under its own bounds.
      expect(Date.now() - signalledAt).toBeLessThan(
        Duration.toMillis(INTERRUPT_BUDGET)
      );

      const artifacts = recordingOf(runs) ?? "";
      const recording = yield* fileSystem.readFile(
        path.join(artifacts, "attempt-1.webm")
      );
      expect(recording.length).toBeGreaterThan(1024);

      const manifest = JSON.parse(
        yield* fileSystem.readFileString(path.join(artifacts, "video.json"))
      ) as RunVideoManifest;
      expect(manifest.segments).toHaveLength(1);
      expect(manifest.segments[0]?.recorded).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive)), {
      retry: WEDGE_RETRIES,
    }
);

it.live.skipIf(!canRecordVideo())(
  "exits promptly and accounts for the recording when interrupted mid-navigation",
  () =>
    Effect.gen(function* interruptedNavigation() {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtures = yield* fixtureServer;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-interrupt-navigation-",
      });

      const flowPath = path.join(directory, "flow.json");
      yield* fileSystem.writeFileString(
        flowPath,
        JSON.stringify({
          // A navigation that never answers, so the signal lands while the
          // browser is still working on it — the case where a flush queued
          // behind that navigation cannot be honoured, and where the Run used
          // to hang indefinitely instead of exiting.
          steps: [
            {
              type: "navigate",
              url: `${fixtures.origin}${NEVER_ANSWERED}`,
            },
          ],
          title: "Interrupted navigation",
        })
      );

      const runs = path.join(directory, "runs");
      const child = yield* start(flowPath, runs);

      // Capture begins before the Flow performs its opening navigation, and a
      // request the fixture server has received but never answers is proof
      // that navigation is still in flight — exactly where the signal has to
      // land.
      const reached = yield* waitUntil(() =>
        fixtures.requests.includes(NEVER_ANSWERED)
      );
      expect(reached).toBe(true);

      const signalledAt = Date.now();
      child.kill("SIGINT");
      yield* waitForExit(child).pipe(Effect.timeout(EXIT_TIMEOUT));
      const tookMs = Date.now() - signalledAt;

      // Ctrl-C has to feel like Ctrl-C even when the browser will never
      // finish what it is doing: the force-exit backstop bounds this.
      expect(tookMs).toBeLessThan(Duration.toMillis(INTERRUPT_BUDGET));

      // The recording could not be flushed — the flush queues behind the
      // navigation the signal interrupted — so no watchable file may be left
      // behind. Even the manifest cannot be written here: teardown's own
      // browser commands queue behind the same jammed navigation, which is
      // why the loss is warned about up front and accepted in ADR 0010.
      // `recordingOf` answers with a directory only when the recording is
      // there, so its absence is the whole assertion.
      const artifacts = recordingOf(runs);
      if (artifacts !== undefined) {
        const bytes = yield* fileSystem.readFile(
          path.join(artifacts, "attempt-1.webm")
        );
        expect(bytes.length).toBeLessThan(1024);
      }
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
