import type { Flow, Run, RunStep } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Stream } from "effect";

import { makeRunSessionService } from "../../src/services/run-session.ts";
import { Runner } from "../../src/services/runner.ts";
import type {
  RunnerRunOptions,
  RunnerService,
} from "../../src/services/runner.ts";

const flow: Flow = {
  steps: [
    { type: "navigate", url: "https://example.com/" },
    { kind: "accessibility", type: "audit" },
  ],
  title: "Checkout",
} as Flow;

const flowWithRuntimeVariable: Flow = {
  ...flow,
  variables: [{ name: "OTP", runtime: true, secret: true }],
} as Flow;

const stepAt = (index: number, outcome: "completed" | "failed"): RunStep => ({
  finishedAt: "2026-01-01T00:00:01.000Z",
  index,
  outcome,
  startedAt: "2026-01-01T00:00:00.000Z",
  type: index === 0 ? "navigate" : "audit",
});

const runWith = (steps: readonly RunStep[]): Run =>
  ({
    attempts: [
      {
        attempt: 1,
        finishedAt: "2026-01-01T00:00:02.000Z",
        outcome: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        steps,
      },
    ],
    environment: {
      architecture: "arm64",
      cpuCount: 8,
      cpuModel: "Apple M2",
      loadAverage: 0,
      memoryBytes: 1,
      platform: "darwin",
    },
    finishedAt: "2026-01-01T00:00:02.000Z",
    flow,
    flowHash: "hash",
    flowId: "checkout",
    outcome: "completed",
    runId: "run-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    steps,
    trace: true,
    video: true,
  }) as Run;

/** A Runner that records how it was invoked and reports two Steps. */
const recordingRunner = () => {
  const invocations: RunnerRunOptions[] = [];
  const service: RunnerService = {
    run: (_flow, options) =>
      Effect.gen(function* fakeRun() {
        invocations.push(options);
        const progress = options.onProgress;
        const steps = [stepAt(0, "completed"), stepAt(1, "completed")];
        if (progress !== undefined) {
          yield* progress.emit({ _tag: "attemptStarted", attempt: 1 });
          for (const step of steps) {
            yield* progress.emit({ _tag: "stepStarted", index: step.index });
            yield* progress.emit({ _tag: "stepFinished", step });
          }
        }
        return { directory: "/runs/checkout/run-1", run: runWith(steps) };
      }),
  };
  return { invocations, service };
};

/**
 * A Runner that asks for a `runtime` Variable when it reaches the Step that
 * references it, exactly as the real one does — never before the Run.
 */
const promptingRunner = () => {
  const invocations: RunnerRunOptions[] = [];
  const service: RunnerService = {
    run: (_flow, options) =>
      Effect.gen(function* fakeRun() {
        invocations.push(options);
        const steps = [stepAt(0, "completed"), stepAt(1, "completed")];
        yield* (
          options.onProgress?.emit({
            _tag: "attemptStarted",
            attempt: 1,
          }) ?? Effect.void
        );
        yield* (
          options.onProgress?.emit({ _tag: "stepStarted", index: 0 }) ??
            Effect.void
        );
        // The Step that references it is where the asking happens.
        yield* (options.variables?.runtime?.resolve("OTP") ?? Effect.void).pipe(
          Effect.orDie
        );
        for (const step of steps) {
          yield* (
            options.onProgress?.emit({ _tag: "stepFinished", step }) ??
              Effect.void
          );
        }
        return { directory: "/runs/checkout/run-1", run: runWith(steps) };
      }),
  };
  return { invocations, service };
};

/** Preflight probes its output directory; no manifest exists to read back. */
const noManifests = FileSystem.layerNoop({
  makeDirectory: () => Effect.void,
  readFileString: () => Effect.die(new Error("ENOENT")),
  remove: () => Effect.void,
  writeFileString: () => Effect.void,
});

const withRunner = (service: RunnerService) =>
  Layer.mergeAll(noManifests, Layer.succeed(Runner, service));

it.live("has nothing to run when the server was opened without a Flow", () =>
  Effect.gen(function* noFlow() {
    const session = yield* makeRunSessionService({
      flow: null,
      outputDirectory: "/runs",
    });
    expect(yield* session.get()).toBeNull();
    const error = yield* Effect.flip(session.start());
    expect(error.code).toBe("run_unavailable");
  }).pipe(Effect.provide(withRunner(recordingRunner().service)))
);

it.live("forces the Trace and the video on for a Run it starts", () =>
  Effect.gen(function* forcedArtifacts() {
    const runner = recordingRunner();
    const session = yield* makeRunSessionService({
      flow,
      outputDirectory: "/runs",
    }).pipe(Effect.provide(withRunner(runner.service)));
    yield* session.start();
    yield* Effect.sleep("50 millis");
    // Stepping the timeline is stepping the frames video derivation captures,
    // so a Run started here cannot disable either artifact (ADR 0023).
    expect(runner.invocations[0]?.trace).toBe(true);
    expect(runner.invocations[0]?.video).toBe(true);
  })
);

it.live("streams each Step as it lands and ends on the finished Run", () =>
  Effect.gen(function* streamsProgress() {
    const runner = recordingRunner();
    const session = yield* makeRunSessionService({
      flow,
      outputDirectory: "/runs",
    }).pipe(Effect.provide(withRunner(runner.service)));
    const seen = yield* session
      .changes()
      .pipe(Stream.take(8), Stream.runCollect, Effect.forkChild);
    yield* Effect.sleep("10 millis");
    yield* session.start();
    const snapshots = yield* Fiber.join(seen);

    // Two `starting` snapshots: the phase change, then preflight's warnings.
    expect(snapshots.map(({ phase }) => phase)).toEqual([
      "starting",
      "starting",
      "running",
      "running",
      "running",
      "running",
      "running",
      "finished",
    ]);
    // A Step is running before it is done, and the timeline reads both.
    expect(snapshots[2]?.runningIndex).toBeUndefined();
    expect(snapshots[3]?.runningIndex).toBe(0);
    expect(snapshots[4]?.steps).toHaveLength(1);
    expect(snapshots.at(-1)?.run?.runId).toBe("run-1");
    expect(snapshots.at(-1)?.steps).toHaveLength(2);
  })
);

it.live("refuses a second Run while one is in flight", () =>
  Effect.gen(function* refusesSecondRun() {
    const service: RunnerService = {
      run: () => Effect.never,
    };
    const session = yield* makeRunSessionService({
      flow,
      outputDirectory: "/runs",
    }).pipe(Effect.provide(withRunner(service)));
    yield* session.start();
    const error = yield* Effect.flip(session.start());
    expect(error.code).toBe("run_conflict");
  })
);

it.live("asks the browser for a runtime Variable and proceeds once told", () =>
  Effect.gen(function* promptsInBrowser() {
    const runner = promptingRunner();
    const session = yield* makeRunSessionService({
      flow: flowWithRuntimeVariable,
      outputDirectory: "/runs",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            makeDirectory: () => Effect.void,
            readFileString: () => Effect.die(new Error("ENOENT")),
            remove: () => Effect.void,
            writeFileString: () => Effect.void,
          }),
          Layer.succeed(Runner, runner.service)
        )
      )
    );
    yield* session.start();
    yield* Effect.sleep("20 millis");

    // A web server is never an interactive terminal, so the prompt seam is
    // answered here rather than failing with the no-terminal error (ADR 0023).
    // It is asked at the Step that references the Variable, not before the
    // Run: a single-use code would otherwise expire while the Run walks to
    // the field it belongs in.
    const asked = yield* session.get();
    expect(asked?.phase).toBe("running");
    expect(asked?.variablePrompt).toEqual({ name: "OTP", secret: true });

    const stale = yield* Effect.flip(session.answerVariable("OTHER", "1"));
    expect(stale.code).toBe("run_invalid");

    yield* session.answerVariable("OTP", "123456");
    yield* Effect.sleep("50 millis");
    const finished = yield* session.get();
    expect(finished?.variablePrompt).toBeNull();
    expect(finished?.phase).toBe("finished");
    expect(runner.invocations[0]?.variables?.values.get("OTP")).toBe("123456");
  })
);

it.live("reports a Run that could not start rather than a failed Run", () =>
  Effect.gen(function* reportsStartFailure() {
    const session = yield* makeRunSessionService({
      // No value can be resolved for a Variable that is neither supplied nor
      // runtime, so preflight refuses before a browser opens.
      flow: {
        ...flow,
        variables: [{ name: "TOKEN", runtime: false, secret: true }],
      } as Flow,
      outputDirectory: "/runs",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            makeDirectory: () => Effect.void,
            readFileString: () => Effect.die(new Error("ENOENT")),
            remove: () => Effect.void,
            writeFileString: () => Effect.void,
          }),
          Layer.succeed(Runner, recordingRunner().service)
        )
      )
    );
    yield* session.start();
    yield* Effect.sleep("50 millis");
    const state = yield* session.get();
    expect(state?.phase).toBe("idle");
    expect(state?.run).toBeNull();
    expect(state?.error).toContain("TOKEN");
  })
);

it.live("resolves a video path only through the finished Run's manifest", () =>
  Effect.gen(function* resolvesArtifacts() {
    const runner = recordingRunner();
    const session = yield* makeRunSessionService({
      flow,
      outputDirectory: "/runs",
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            makeDirectory: () => Effect.void,
            readFileString: (file) =>
              String(file).endsWith("video.json")
                ? Effect.succeed(
                    JSON.stringify({
                      containsSecrets: false,
                      runId: "run-1",
                      segments: [
                        {
                          attempt: 1,
                          file: "attempt-1.webm",
                          includesSettledState: true,
                          recorded: true,
                          steps: [0, 1],
                        },
                      ],
                    })
                  )
                : Effect.die(new Error("ENOENT")),
            remove: () => Effect.void,
            writeFileString: () => Effect.void,
          }),
          Layer.succeed(Runner, runner.service)
        )
      )
    );
    const before = yield* Effect.flip(
      session.artifactPath("run-1", 1, "video")
    );
    expect(before.code).toBe("run_invalid");

    yield* session.start();
    yield* Effect.sleep("50 millis");

    expect(yield* session.artifactPath("run-1", 1, "video")).toBe(
      "/runs/checkout/run-1/attempt-1.webm"
    );
    // A Run the process does not hold is not addressable, and neither is an
    // attempt whose segment is not in the manifest.
    expect(
      (yield* Effect.flip(session.artifactPath("other", 1, "video"))).code
    ).toBe("run_invalid");
    expect(
      (yield* Effect.flip(session.artifactPath("run-1", 2, "video"))).code
    ).toBe("run_invalid");
  })
);

it.live(
  "loads a Flow the browser handed over to a server started without one",
  () =>
    Effect.gen(function* loadsFlow() {
      const session = yield* makeRunSessionService({
        flow: null,
        outputDirectory: "/runs",
      });
      const loaded = yield* session.loadFlow(
        JSON.stringify(flow),
        "checkout.json"
      );
      expect(loaded.flow.title).toBe("Checkout");
      expect(loaded.phase).toBe("idle");
      // The Flow is now the loaded one, so starting is no longer refused.
      expect((yield* session.get())?.flow.title).toBe("Checkout");
    }).pipe(Effect.provide(withRunner(recordingRunner().service)))
);

it.live("refuses a Flow document it cannot decode, naming the file", () =>
  Effect.gen(function* rejectsBadFlow() {
    const session = yield* makeRunSessionService({
      flow: null,
      outputDirectory: "/runs",
    });
    const error = yield* Effect.flip(
      session.loadFlow("{ not json", "broken.json")
    );
    expect(error.code).toBe("run_invalid");
    expect(error.message).toContain("broken.json");
    // Nothing was loaded, so there is still nothing to audit.
    expect(yield* session.get()).toBeNull();
  }).pipe(Effect.provide(withRunner(recordingRunner().service)))
);

it.live("refuses to swap the Flow out from under a Run in flight", () =>
  Effect.gen(function* refusesDuringRun() {
    const session = yield* makeRunSessionService({
      flow,
      outputDirectory: "/runs",
    }).pipe(Effect.provide(withRunner(recordingRunner().service)));
    yield* session.start();
    const error = yield* Effect.flip(
      session.loadFlow(JSON.stringify(flow), "other.json")
    );
    expect(error.code).toBe("run_conflict");
  })
);

it.live("never leaves a dead prompt on a Run that has ended", () =>
  Effect.gen(function* deadPrompt() {
    const service: RunnerService = {
      // A Run that ends while the prompt is unanswered: the ceiling
      // interrupts the awaiting fiber and the Runner reports a failed Run.
      run: (_flow, options) =>
        Effect.gen(function* abandonPrompt() {
          const steps = [stepAt(0, "failed")];
          yield* (
            options.variables?.runtime
              ?.resolve("OTP")
              .pipe(Effect.timeout("20 millis"), Effect.ignore) ?? Effect.void
          );
          return { directory: "/runs/checkout/run-1", run: runWith(steps) };
        }),
    };
    const session = yield* makeRunSessionService({
      flow: flowWithRuntimeVariable,
      outputDirectory: "/runs",
    }).pipe(Effect.provide(withRunner(service)));

    yield* session.start();
    yield* Effect.sleep("120 millis");

    const ended = yield* session.get();
    expect(ended?.phase).toBe("finished");
    // Nobody is left to answer it, so the question does not outlive the Run.
    expect(ended?.variablePrompt).toBeNull();
    // And a late answer is refused rather than reported as accepted and
    // silently dropped.
    const late = yield* Effect.flip(session.answerVariable("OTP", "123456"));
    expect(late.code).toBe("run_invalid");
  })
);
