import { FlowName, OperationId } from "@contingency/protocol";
import type {
  IosWorkspaceCommand,
  IosWorkspaceSelection,
  NativeInput,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stream } from "effect";

import { makeFlowCatalogLayer } from "../../src/services/flow-catalog.ts";
import {
  iosCapabilities,
  iosRuntimeError,
  iosSystemKeys,
} from "../../src/services/ios-runtime.ts";
import type {
  IosObservation,
  IosRunInput,
} from "../../src/services/ios-runtime.ts";
import type { IosDeviceStream } from "../../src/services/ios-stream.ts";
import {
  IosWorkspace,
  makeIosWorkspaceLayer,
} from "../../src/services/ios-workspace.ts";
import { NativeAgentTouches } from "../../src/services/native-agent-touch.ts";
import type { NativeAgentGesture } from "../../src/services/native-agent-touch.ts";
import { nativeAppActionPolicy } from "../../src/services/native-app-action-policy.ts";
import type { NativeAppRunDecision } from "../../src/services/native-app-run-contract.ts";
import { createNativeAppRun } from "../../src/services/native-app-run.ts";
import { adaptNativeAppRuntime } from "../../src/services/native-app-runtime.ts";
import { makeTeachingRecordingStoreLayer } from "../../src/services/teaching-recording-store.ts";

const simulator = {
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  kind: "simulator",
  name: "iPhone 17",
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  runtimeVersion: "26.5",
  udid: "11111111-2222-3333-4444-555555555555",
} as const;
const selection: IosWorkspaceSelection = {
  device: simulator,
  environment: {
    build: "1",
    bundleId: "dev.contingency.ioslogin",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    runtimeVersion: "26.5",
  },
  outcomes: [],
  setup: { conditions: [], kind: "restart-app" },
};

/** A portrait screenshot's header: only its size is read. */
const screenshot = () => {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(1206, 16);
  bytes.writeUInt32BE(2622, 20);
  return bytes.toString("base64");
};
/** The Sign in button, in screenshot pixels. */
const signIn = { height: 100, width: 600, x: 300, y: 1200 };

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

const tap = (x: number, y: number): readonly [NativeInput, NativeInput] => [
  { _tag: "touch", action: "down", at: 0, x, y },
  { _tag: "touch", action: "up", at: 0, x, y },
];

interface TouchRecord {
  readonly sessionId: string;
  readonly gesture: NativeAgentGesture;
  readonly screen: { readonly width: number; readonly height: number };
}

/**
 * The live stage draws the agent's touch (ADR 0046), and only the agent's:
 * once the user holds the simulator, neither their semantic pick nor their
 * Forwarded Input is drawn (ADR 0076).
 */
it.effect(
  "publishes a touch for the agent's activation and none for the user's input",
  () =>
    Effect.gen(function* agentTouchOnIos() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      let generation = 0;
      const activations: string[] = [];
      const touches: TouchRecord[] = [];
      const capture = () =>
        Effect.sync((): IosObservation => {
          generation += 1;
          return {
            appId: "dev.contingency.ioslogin",
            backendSessionId: "fixture-session",
            device: simulator,
            generation,
            id: `observation-${generation}`,
            nodes: [
              {
                bounds: signIn,
                covered: false,
                editable: false,
                hittable: true,
                name: "Sign in",
                packageName: "dev.contingency.ioslogin",
                password: false,
                role: "button",
                target: `@e1~s${generation}`,
              },
            ],
            platform: "ios",
            screenshot: {
              capturedAt: "2026-11-18T00:00:00.000Z",
              encoding: "base64",
              format: "png",
              image: screenshot(),
            },
          };
        });
      const createRun = (input: IosRunInput) =>
        createNativeAppRun<IosRunInput, IosObservation, NativeAppRunDecision>(
          input,
          {
            authorize: (request) => request,
            decisions: () => [],
            differences: () => [],
            error: iosRuntimeError,
            preflight: () => Effect.void,
            start: (request) =>
              adaptNativeAppRuntime({
                backend: {
                  activate: (target) =>
                    Effect.sync(() => {
                      activations.push(target);
                    }),
                  capture,
                  close: () => Effect.void,
                  fill: () =>
                    Effect.succeed({
                      confirmation: "unconfirmed" as const,
                      outcome: "entered" as const,
                    }),
                  recover: () => Effect.void,
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
            startingConditions: () => true,
            validate: () => Effect.void,
          }
        );
      // Records each touch instead of drawing it, so no touch waits.
      const touchLayer = Layer.succeed(
        NativeAgentTouches,
        NativeAgentTouches.of({
          release: () => Effect.void,
          stream: () => Stream.empty,
          touch: (sessionId, gesture, screen) =>
            Effect.sync(() => {
              touches.push({ gesture, screen, sessionId });
            }),
        })
      );
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const workspaceLayer = makeIosWorkspaceLayer({
        acquireStream: () => Effect.succeed(fakeStream()),
        booted: () => Effect.succeed(true),
        createRun,
        makeHid: () => Effect.succeed({ forward: () => Effect.void }),
        root: () => root,
        simctl: () => Effect.succeed("light"),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(storeLayer, makeFlowCatalogLayer({ root }), touchLayer)
        )
      );
      yield* Effect.gen(function* driveThenHandOff() {
        const workspace = yield* IosWorkspace;
        // Agent-led setup: the agent holds the simulator until it hands off.
        const started = yield* workspace.execute(
          {
            _tag: "start",
            agentSetup: true,
            flowName: FlowName.make("touch"),
            kind: "teaching",
            operationId: OperationId.make("touch-start"),
            recordingId: null,
            selection,
          },
          "agent"
        );
        let step = 0;
        const run = (
          command: (fields: {
            readonly operationId: OperationId;
            readonly sessionId: typeof started.id;
          }) => IosWorkspaceCommand,
          source: "agent" | "user"
        ) => {
          step += 1;
          return workspace.execute(
            command({
              operationId: OperationId.make(`touch-${step}`),
              sessionId: started.id,
            }),
            source
          );
        };
        yield* run((fields) => ({ _tag: "prepare", ...fields }), "user");
        const activate = (source: "agent" | "user") =>
          Effect.gen(function* activateSignIn() {
            const shown = yield* workspace.execute(
              { _tag: "observe", image: false, sessionId: started.id },
              source
            );
            const button = shown.observation?.nodes[0];
            if (shown.observation === null || button === undefined) {
              return yield* Effect.die("Sign in must be observed");
            }
            const observationId = shown.observation.id;
            return yield* run(
              (fields) => ({
                _tag: "input",
                ...fields,
                action: { _tag: "activate", target: button.target },
                observationId,
              }),
              source
            );
          });

        yield* activate("agent");
        expect(activations).toHaveLength(1);
        // The centre of Sign in, on the 1206 by 2622 screenshot.
        expect(touches).toEqual([
          {
            gesture: { action: "tap", x: 600, y: 1250 },
            screen: { height: 2622, width: 1206 },
            sessionId: started.id,
          },
        ]);

        yield* run((fields) => ({ _tag: "setup-handoff", ...fields }), "agent");
        yield* activate("user");
        yield* workspace.forward(
          { inputs: tap(0.5, 0.5), sessionId: started.id },
          "user"
        );
        expect(activations).toHaveLength(2);
        expect(touches).toHaveLength(1);
        yield* run((fields) => ({ _tag: "close", ...fields }), "user");
      }).pipe(Effect.provide(Layer.merge(storeLayer, workspaceLayer)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
