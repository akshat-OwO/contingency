import { spawn } from "node:child_process";
import path from "node:path";

import type { RunVideoManifest } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { fixtureServer, IntegrationLive } from "./harness";

/** Long enough for the browser to open the page and start recording. */
const BEFORE_SIGNAL_MS = 8000;

/** The Run waits on a request nothing answers, so this only bounds failure. */
const AFTER_SIGNAL_MS = 90_000;

/**
 * The CLI as a user runs it, interrupted the way a Ctrl-C or a cancelled CI
 * job interrupts it.
 *
 * Interrupting the Effect fiber directly is not the same test: it invokes the
 * finalizers by hand, while a signal has to travel through the process first.
 */
const runUntilInterrupted = (
  flowPath: string,
  outputDirectory: string
  // `null` rather than nothing: an explicit `undefined` here is rewritten by
  // the formatter into a call that does not typecheck.
): Effect.Effect<null> =>
  Effect.callback<null>((resume) => {
    const child = spawn(
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
    );
    const signal = setTimeout(() => {
      child.kill("SIGINT");
    }, BEFORE_SIGNAL_MS);
    const giveUp = setTimeout(() => {
      child.kill("SIGKILL");
    }, AFTER_SIGNAL_MS);
    child.on("exit", () => {
      clearTimeout(signal);
      clearTimeout(giveUp);
      resume(Effect.succeed(null));
    });
  });

it.live("leaves a flushed recording when a Run is interrupted", () =>
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

    yield* runUntilInterrupted(flowPath, path.join(directory, "runs"));

    // An unflushed recording is a lost recording, and the Runs whose video
    // matters most are exactly the ones that never reach a tidy end.
    const runs = path.join(directory, "runs");
    const [flowDirectory] = yield* fileSystem.readDirectory(runs);
    const [runDirectory] = yield* fileSystem.readDirectory(
      path.join(runs, flowDirectory ?? "")
    );
    const artifacts = path.join(runs, flowDirectory ?? "", runDirectory ?? "");

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
