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
    const runner = recordingRunner();
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
    const asked = yield* session.get();
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
