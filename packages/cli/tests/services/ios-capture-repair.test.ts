import { FlowName, OperationId } from "@contingency/protocol";
import type {
  AgentSessionId,
  IosWorkspaceSelection,
  TeachingRecordingId,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Result, Stream } from "effect";
import { TestClock } from "effect/testing";

import { makeFlowCatalogLayer } from "../../src/services/flow-catalog.ts";
import {
  iosCapabilities,
  iosRuntimeError,
  iosSystemKeys,
} from "../../src/services/ios-runtime.ts";
import type { IosObservation } from "../../src/services/ios-runtime.ts";
import type { IosDeviceStream } from "../../src/services/ios-stream.ts";
import {
  IosWorkspace,
  makeIosWorkspaceLayer,
} from "../../src/services/ios-workspace.ts";
import type { IosWorkspaceService } from "../../src/services/ios-workspace.ts";
import { nativeAppActionPolicy } from "../../src/services/native-app-action-policy.ts";
import { adaptNativeAppRuntime } from "../../src/services/native-app-runtime.ts";
import {
  TeachingRecordingLearning,
  TeachingRecordingLearningLive,
} from "../../src/services/teaching-recording-learning.ts";
import type { TeachingRecordingLearningService } from "../../src/services/teaching-recording-learning.ts";
import {
  TeachingRecordingStore,
  makeTeachingRecordingStoreLayer,
} from "../../src/services/teaching-recording-store.ts";
import type { TeachingRecordingStoreService } from "../../src/services/teaching-recording-store.ts";

const udid = "11111111-2222-3333-4444-555555555555";
const app = "dev.contingency.ioslogin";
const simulator = {
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  kind: "simulator",
  name: "iPhone 17",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  runtimeVersion: "26.5",
  udid,
} as const;
const selection: IosWorkspaceSelection = {
  device: simulator,
  environment: {
    build: "1",
    bundleId: app,
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    runtimeVersion: "26.5",
  },
  outcomes: [],
  setup: { conditions: [], kind: "restart-app" },
};
const flowName = FlowName.make("ios-repair");
const flow = `---\nname: ios-repair\ndescription: Open the fixture app. Use when testing iOS capture repair.\ninputs:\n---\n\n# Open\n\n1. Activate Continue. Done when: the app is visible.\n`;
const op = OperationId.make;

/** A screenshot's header: only its size is read. */
const screenshot = () => {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(1206, 16);
  bytes.writeUInt32BE(2622, 20);
  return bytes.toString("base64");
};

/** The mirror, without a simulator: always ready to capture. */
const fakeStream = (): IosDeviceStream => ({
  access: { path: "/ios/stream/fixture", token: "fixture" },
  authorized: () => false,
  begin: () => Effect.succeed(true),
  close: () => Effect.void,
  end: () => Effect.succeed(null),
  frames: Stream.empty,
  integrity: () => null,
  recover: () => Effect.sync((): undefined => {}),
  start: () => Effect.sync((): undefined => {}),
});

/**
 * Runs a command whose captures retry on the settle schedule. `it.effect`
 * provides TestClock, so advancing past the settle window wakes each retry.
 */
const settled = <A, E, R>(command: Effect.Effect<A, E, R>) =>
  Effect.gen(function* runSettled() {
    const fiber = yield* Effect.forkChild(Effect.result(command));
    yield* TestClock.adjust("30 seconds");
    return yield* Fiber.join(fiber);
  });

const fixture = <A, E>(
  test: (device: {
    readonly activations: () => number;
    readonly recoveries: () => number;
    /** Fails the next `count` captures as incomplete. */
    readonly failNextCaptures: (count: number) => void;
    /** Fails every capture as incomplete until the session is recovered. */
    readonly failCapturesUntilRecover: () => void;
  }) => Effect.Effect<
    A,
    E,
    | IosWorkspaceService
    | TeachingRecordingStoreService
    | TeachingRecordingLearningService
  >
) =>
  Effect.gen(function* iosFixture() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    let generation = 0;
    let activations = 0;
    let recoveries = 0;
    let incomplete = 0;
    let untilRecover = false;
    const capture = () =>
      Effect.suspend(() => {
        if (untilRecover || incomplete > 0) {
          incomplete = Math.max(0, incomplete - 1);
          return Effect.fail(iosRuntimeError("capture_incomplete"));
        }
        generation += 1;
        return Effect.succeed<IosObservation>({
          appId: app,
          backendSessionId: "fixture-session",
          device: simulator,
          generation,
          id: `observation-${generation}`,
          nodes: [
            {
              covered: false,
              editable: false,
              hittable: true,
              name: "Continue",
              packageName: app,
              password: false,
              role: "button",
              target: `@e1~s${generation}`,
            },
          ],
          platform: "ios",
          screenshot: {
            capturedAt: "2026-11-15T00:00:00.000Z",
            encoding: "base64",
            format: "png",
            image: screenshot(),
          },
        });
      });
    const store = makeTeachingRecordingStoreLayer({ root: () => root });
    const workspace = makeIosWorkspaceLayer({
      acquireStream: () => Effect.succeed(fakeStream()),
      booted: () => Effect.succeed(true),
      makeHid: () => Effect.succeed({ forward: () => Effect.void }),
      root: () => root,
      runDeps: {
        installedBuild: () => Effect.succeed("1"),
        preflight: () => Effect.void,
        restart: () => Effect.void,
        start: (request) =>
          adaptNativeAppRuntime({
            backend: {
              activate: () =>
                Effect.sync(() => {
                  activations += 1;
                }),
              capture,
              close: () => Effect.void,
              fill: () =>
                Effect.succeed({
                  confirmation: "confirmed" as const,
                  outcome: "entered" as const,
                }),
              recover: () =>
                Effect.sync(() => {
                  recoveries += 1;
                  untilRecover = false;
                }),
              rotate: () => Effect.void,
              sessionId: "fixture-session",
              systemKey: () => Effect.void,
              validate: () => Effect.void,
            },
            capabilities: iosCapabilities,
            error: iosRuntimeError,
            policy: nativeAppActionPolicy(iosRuntimeError, iosSystemKeys),
            startup: request,
          }),
      },
      simctl: (args) =>
        Effect.succeed(args.at(0) === "ui" && args.length < 4 ? "light" : ""),
    }).pipe(Layer.provide(Layer.merge(store, makeFlowCatalogLayer({ root }))));
    const learning = TeachingRecordingLearningLive.pipe(Layer.provide(store));
    return yield* test({
      activations: () => activations,
      failCapturesUntilRecover: () => {
        untilRecover = true;
      },
      failNextCaptures: (count) => {
        incomplete = count;
      },
      recoveries: () => recoveries,
    }).pipe(Effect.provide(Layer.mergeAll(store, workspace, learning)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/**
 * Teaches and saves a one-tap Flow, returning its recording. The user closes
 * the stopped Teaching session first unless `closeTeaching` is false.
 */
const teachFlow = (closeTeaching: boolean) =>
  Effect.gen(function* teachOneTap() {
    const workspace = yield* IosWorkspace;
    const started = yield* workspace.execute(
      {
        _tag: "start",
        flowName,
        kind: "teaching",
        operationId: op("teach-start"),
        recordingId: null,
        selection,
      },
      "user"
    );
    yield* workspace.execute(
      {
        _tag: "prepare",
        operationId: op("teach-prepare"),
        sessionId: started.id,
      },
      "user"
    );
    yield* workspace.execute(
      {
        _tag: "record",
        operationId: op("teach-record"),
        sessionId: started.id,
        start: true,
      },
      "user"
    );
    const observed = yield* workspace.execute(
      { _tag: "observe", image: false, sessionId: started.id },
      "agent"
    );
    yield* workspace.execute(
      {
        _tag: "input",
        action: {
          _tag: "activate",
          target: observed.observation?.nodes[0]?.target ?? "",
        },
        observationId: observed.observation?.id ?? "",
        operationId: op("teach-tap"),
        sessionId: started.id,
      },
      "user"
    );
    const stopped = yield* workspace.execute(
      {
        _tag: "record",
        operationId: op("teach-stop"),
        sessionId: started.id,
        start: false,
      },
      "user"
    );
    if (closeTeaching) {
      yield* workspace.execute(
        {
          _tag: "close",
          operationId: op("teach-close"),
          sessionId: started.id,
        },
        "user"
      );
    }
    if (stopped.recordingId === null) {
      return yield* Effect.die("Teaching must own a recording");
    }
    const store = yield* TeachingRecordingStore;
    yield* store.startLearning({
      operationId: op("claim"),
      recordingId: stopped.recordingId,
    });
    const learning = yield* TeachingRecordingLearning;
    yield* learning.save({
      claimOperationId: op("claim"),
      files: [{ content: flow, path: "flow.md" }],
      nativeConditions: {
        outcomes: [{ name: "Continue", role: "button" }],
        starting: [{ name: "Continue", role: "button" }],
      },
      operationId: op("save"),
      recordingId: stopped.recordingId,
    });
    return stopped.recordingId;
  });
const teach = teachFlow(true);

const dryRun = (recordingId: TeachingRecordingId) =>
  Effect.gen(function* startDryRun() {
    const workspace = yield* IosWorkspace;
    const started = yield* workspace.execute(
      {
        _tag: "start",
        flowName,
        kind: "dry-run",
        operationId: op("dry-start"),
        recordingId,
        selection,
      },
      "agent"
    );
    return yield* workspace.execute(
      {
        _tag: "prepare",
        operationId: op("dry-prepare"),
        sessionId: started.id,
      },
      "user"
    );
  });

const tap = (
  sessionId: AgentSessionId,
  observationId: string,
  target: string
) =>
  Effect.gen(function* tapContinue() {
    const workspace = yield* IosWorkspace;
    return yield* settled(
      workspace.execute(
        {
          _tag: "input",
          action: { _tag: "activate", target },
          observationId,
          operationId: op("dry-tap"),
          sessionId,
        },
        "agent"
      )
    );
  });

const assess = (sessionId: AgentSessionId, observationId: string) =>
  Effect.gen(function* assessWorking() {
    const workspace = yield* IosWorkspace;
    return yield* workspace.execute(
      {
        _tag: "complete",
        assessment: {
          explanation: "Continue is visible.",
          observationId,
          outcome: "working",
        },
        operationId: op("dry-complete"),
        sessionId,
      },
      "agent"
    );
  });

it.effect("an iOS transient incomplete capture settles without a gap", () =>
  fixture(({ activations, failNextCaptures, recoveries }) =>
    Effect.gen(function* settleIos() {
      const workspace = yield* IosWorkspace;
      const prepared = yield* dryRun(yield* teach);
      const before = activations();
      failNextCaptures(3);
      const tapped = yield* tap(
        prepared.id,
        prepared.observation?.id ?? "",
        prepared.observation?.nodes[0]?.target ?? ""
      );
      expect(Result.isSuccess(tapped)).toBe(true);
      expect(activations()).toBe(before + 1);
      expect(recoveries()).toBe(0);
      const read = yield* workspace.execute(
        { _tag: "read", sessionId: prepared.id },
        "agent"
      );
      expect(read).toMatchObject({ captureGaps: [], phase: "running" });
      const completed = yield* assess(prepared.id, read.observation?.id ?? "");
      expect(completed.assessment?.outcome).toBe("working");
    })
  )
);

it.effect(
  "an iOS lasting incomplete capture is repaired automatically and still passes",
  () =>
    fixture(({ activations, failCapturesUntilRecover, recoveries }) =>
      Effect.gen(function* repairIos() {
        const workspace = yield* IosWorkspace;
        const prepared = yield* dryRun(yield* teach);
        const before = activations();
        failCapturesUntilRecover();
        const tapped = yield* tap(
          prepared.id,
          prepared.observation?.id ?? "",
          prepared.observation?.nodes[0]?.target ?? ""
        );
        expect(Result.isSuccess(tapped)).toBe(true);
        expect(activations()).toBe(before + 1);
        expect(recoveries()).toBe(1);
        const read = yield* workspace.execute(
          { _tag: "read", sessionId: prepared.id },
          "agent"
        );
        expect(read).toMatchObject({
          captureGaps: ["capture_incomplete"],
          captureRepairs: [{ by: "automatic", code: "capture_incomplete" }],
          phase: "running",
        });
        const completed = yield* assess(
          prepared.id,
          read.observation?.id ?? ""
        );
        expect(completed.assessment?.outcome).toBe("working");
      })
    )
);

it.effect(
  "an iOS gap automatic recovery cannot repair pauses until the user recovers it",
  () =>
    fixture(({ failNextCaptures, recoveries }) =>
      Effect.gen(function* userRepairsIos() {
        const workspace = yield* IosWorkspace;
        const prepared = yield* dryRun(yield* teach);
        failNextCaptures(1_000_000);
        const tapped = yield* tap(
          prepared.id,
          prepared.observation?.id ?? "",
          prepared.observation?.nodes[0]?.target ?? ""
        );
        expect(Result.isFailure(tapped)).toBe(true);
        expect(recoveries()).toBe(1);
        const paused = yield* workspace.execute(
          { _tag: "read", sessionId: prepared.id },
          "agent"
        );
        expect(paused).toMatchObject({
          captureGaps: ["capture_incomplete"],
          phase: "paused",
        });
        expect(paused.captureRepairs).toBeUndefined();
        failNextCaptures(0);
        const recovered = yield* workspace.execute(
          {
            _tag: "recover",
            operationId: op("dry-recover"),
            sessionId: prepared.id,
          },
          "user"
        );
        expect(recovered.captureRepairs).toMatchObject([
          { by: "user", code: "capture_incomplete" },
        ]);
        const completed = yield* assess(
          prepared.id,
          recovered.observation?.id ?? ""
        );
        expect(completed.assessment?.outcome).toBe("working");
      })
    )
);

it.effect(
  "an iOS Dry Run start takes the device from its recording's stopped Teaching session (#725)",
  () =>
    fixture(() =>
      Effect.gen(function* handOffIos() {
        const workspace = yield* IosWorkspace;
        const recordingId = yield* teachFlow(false);
        const [teaching] = yield* workspace.list();
        if (teaching === undefined) {
          return yield* Effect.die(
            "The stopped Teaching session must stay listed."
          );
        }
        expect(teaching).toMatchObject({
          controller: "user",
          kind: "teaching",
          phase: "running",
        });
        // A Dry Run start its own checks refuse leaves Teaching bound.
        const refused = yield* Effect.flip(
          workspace.execute(
            {
              _tag: "start",
              flowName: FlowName.make("ios-missing"),
              kind: "dry-run",
              operationId: op("dry-missing"),
              recordingId,
              selection,
            },
            "agent"
          )
        );
        expect(refused.message).not.toContain("already bound");
        expect((yield* workspace.list()).map(({ id }) => id)).toEqual([
          teaching.id,
        ]);
        const prepared = yield* dryRun(recordingId);
        expect(prepared).toMatchObject({ kind: "dry-run", phase: "running" });
        const closed = yield* workspace.execute(
          { _tag: "read", sessionId: teaching.id },
          "user"
        );
        expect(closed.phase).toBe("closed");
        expect(closed.handedOffTo).toBe(prepared.id);
        expect((yield* workspace.list()).map(({ id }) => id)).toEqual([
          prepared.id,
        ]);
      })
    )
);
