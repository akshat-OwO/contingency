import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
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
} from "./harness";

/** Bounds failure only; readiness is waited for, never assumed. */
const READY_TIMEOUT = Duration.seconds(60);

const READY_POLL = Duration.millis(250);

/** How long the interrupted Run gets to flush before the test gives up. */
const EXIT_TIMEOUT = Duration.seconds(90);

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

const waitForExit = (child: ChildProcess): Effect.Effect<null> =>
  // `null` rather than nothing: the formatter rewrites an explicit `undefined`
  // here into a call that does not typecheck.
  Effect.callback<null>((resume) => {
    child.on("exit", () => {
      resume(Effect.succeed(null));
    });
  });

it.live.skipIf(!canRecordVideo())(
  "leaves a flushed recording when a Run is interrupted",
  () =>
    Effect.gen(function* interruptedRun() {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtures = yield* fixtureServer;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "contingency-interrupt-",
      });

      const flowPath = path.join(directory, "flow.json");
      yield* fileSystem.writeFileString(
        flowPath,
        JSON.stringify({
          steps: [
            { type: "navigate", url: fixtures.url("checkout.html") },
            { type: "navigate", url: fixtures.url("slow.html") },
          ],
          title: "Interrupted",
        })
      );

      const runs = path.join(directory, "runs");
      const child = yield* start(flowPath, runs);

      // Wait for the Run to be observably where the test needs it, rather than
      // for a duration that happens to be long enough on this machine. The
      // request for the page's never-answered resource can only arrive after the
      // browser launched, the recording started, and the second navigation
      // began, which is precisely the state a Ctrl-C has to survive.
      const reached = yield* waitUntil(() =>
        fixtures.requests.includes(NEVER_ANSWERED)
      );
      expect(reached).toBe(true);

      child.kill("SIGINT");
      yield* waitForExit(child).pipe(Effect.timeout(EXIT_TIMEOUT));

      // An unflushed recording is a lost recording, and the Runs whose video
      // matters most are exactly the ones that never reach a tidy end.
      const [flowDirectory] = yield* fileSystem.readDirectory(runs);
      const [runDirectory] = yield* fileSystem.readDirectory(
        path.join(runs, flowDirectory ?? "")
      );
      const artifacts = path.join(
        runs,
        flowDirectory ?? "",
        runDirectory ?? ""
      );

      const recording = yield* fileSystem.readFile(
        path.join(artifacts, "attempt-1.webm")
      );
      expect(recording.length).toBeGreaterThan(1024);

      // And a recording nobody can attribute to a Run is very nearly a lost one.
      const manifest = JSON.parse(
        yield* fileSystem.readFileString(path.join(artifacts, "video.json"))
      ) as RunVideoManifest;
      expect(manifest.segments).toHaveLength(1);
      expect(manifest.segments[0]?.recorded).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
