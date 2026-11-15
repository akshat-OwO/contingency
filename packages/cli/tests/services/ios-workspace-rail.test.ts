import { FlowName, OperationId } from "@contingency/protocol";
import type {
  IosWorkspaceCommand,
  IosWorkspaceSelection,
  NativeOrientation,
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
import { nativeAppActionPolicy } from "../../src/services/native-app-action-policy.ts";
import type { NativeAppRunDecision } from "../../src/services/native-app-run-contract.ts";
import { createNativeAppRun } from "../../src/services/native-app-run.ts";
import { adaptNativeAppRuntime } from "../../src/services/native-app-runtime.ts";
import {
  TeachingRecordingStore,
  makeTeachingRecordingStoreLayer,
} from "../../src/services/teaching-recording-store.ts";

const udid = "11111111-2222-3333-4444-555555555555";
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
    bundleId: "dev.contingency.ioslogin",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
    runtimeVersion: "26.5",
  },
  outcomes: [],
  setup: { conditions: [], kind: "restart-app" },
};

/** What the fake simulator shows and every command it was sent. */
interface FakeSimulator {
  app: string;
  appearance: "light" | "dark";
  calls: string[];
  orientation: NativeOrientation;
}

/** A screenshot's header: only its size is read. */
const screenshot = (orientation: NativeOrientation) => {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(orientation === "portrait" ? 1206 : 2622, 16);
  bytes.writeUInt32BE(orientation === "portrait" ? 2622 : 1206, 20);
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

it.effect(
  "drives the iOS rail: Home and the App Switcher through the runtime, no Back, and an Emulation restored at the end",
  () =>
    Effect.gen(function* iosRail() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const device: FakeSimulator = {
        app: "dev.contingency.ioslogin",
        appearance: "light",
        calls: [],
        orientation: "portrait",
      };
      let generation = 0;
      // When set, the observer cannot name the app in front.
      let unknown = false;
      let recoveries = 0;
      const capture = () =>
        Effect.suspend(() =>
          unknown
            ? Effect.fail(iosRuntimeError("foreground_app_unknown"))
            : Effect.void
        ).pipe(
          Effect.map((): IosObservation => {
            generation += 1;
            return {
              appId: device.app,
              backendSessionId: "fixture-session",
              device: simulator,
              generation,
              id: `observation-${generation}`,
              nodes: [
                {
                  covered: false,
                  editable: false,
                  hittable: true,
                  name: device.app,
                  packageName: device.app,
                  password: false,
                  role: "text",
                  target: `@e1~s${generation}`,
                },
              ],
              platform: "ios",
              screenshot: {
                capturedAt: "2026-11-15T00:00:00.000Z",
                encoding: "base64",
                format: "png",
                image: screenshot(device.orientation),
              },
            };
          })
        );
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
                  activate: () => Effect.void,
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
                      unknown = false;
                    }),
                  rotate: (orientation) =>
                    Effect.sync(() => {
                      device.calls.push(`rotate ${orientation}`);
                      device.orientation = orientation;
                    }),
                  sessionId: "fixture-session",
                  systemKey: (key) =>
                    Effect.sync(() => {
                      device.calls.push(key);
                      device.app = "com.apple.springboard";
                    }),
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
      const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
      const workspaceLayer = makeIosWorkspaceLayer({
        acquireStream: () => Effect.succeed(fakeStream()),
        booted: () => Effect.succeed(true),
        createRun,
        makeHid: () => Effect.succeed({ forward: () => Effect.void }),
        root: () => root,
        simctl: (args) =>
          Effect.sync(() => {
            const command = args.at(0);
            const value = args.at(3);
            if (command === "ui" && value === undefined) {
              return device.appearance;
            }
            device.calls.push(`simctl ${args.join(" ")}`);
            if (command === "ui" && (value === "light" || value === "dark")) {
              device.appearance = value;
            }
            return "";
          }),
      }).pipe(
        Layer.provide(Layer.merge(storeLayer, makeFlowCatalogLayer({ root })))
      );
      yield* Effect.gen(function* teachOnTheRail() {
        const workspace = yield* IosWorkspace;
        const store = yield* TeachingRecordingStore;
        const started = yield* workspace.execute(
          {
            _tag: "start",
            flowName: FlowName.make("rail"),
            kind: "teaching",
            operationId: OperationId.make("rail-start"),
            recordingId: null,
            selection,
          },
          "user"
        );
        let step = 0;
        const run = (
          command: (fields: {
            readonly operationId: OperationId;
            readonly sessionId: typeof started.id;
          }) => IosWorkspaceCommand,
          source: "agent" | "user" = "user"
        ) => {
          step += 1;
          return workspace.execute(
            command({
              operationId: OperationId.make(`rail-${step}`),
              sessionId: started.id,
            }),
            source
          );
        };
        yield* run((fields) => ({ _tag: "prepare", ...fields }));
        yield* run((fields) => ({ _tag: "record", ...fields, start: true }));
        if (started.recordingId === null) {
          return yield* Effect.die("Teaching must own a recording");
        }
        // Teaching records the Emulation it started under.
        const { runtime } = yield* store.read(started.recordingId);
        expect(
          runtime?.platform === "ios" ? runtime.preparation?.emulation : null
        ).toEqual({
          appearance: "light",
          location: null,
          orientation: "portrait",
        });
        // The rail's Home needs no retained observation, and Springboard is
        // observed after it.
        const home = yield* run((fields) => ({
          _tag: "input",
          ...fields,
          action: { _tag: "home" },
          observationId: "rail",
        }));
        expect(home.phase).toBe("running");
        expect(home.observation?.nodes[0]?.name).toBe("com.apple.springboard");
        yield* run((fields) => ({
          _tag: "input",
          ...fields,
          action: { _tag: "app-switcher" },
          observationId: "rail",
        }));
        // iOS has no Back: refused, and the session keeps running.
        const back = yield* Effect.flip(
          run((fields) => ({
            _tag: "input",
            ...fields,
            action: { _tag: "back" },
            observationId: "rail",
          }))
        );
        expect(back.code).toBe("ios_workspace_refused");
        const dark = yield* run((fields) => ({
          _tag: "emulate",
          ...fields,
          change: { _tag: "appearance", appearance: "dark" },
        }));
        expect(dark.emulation?.appearance).toBe("dark");
        const turned = yield* run((fields) => ({
          _tag: "emulate",
          ...fields,
          change: { _tag: "orientation", orientation: "landscape" },
        }));
        expect(turned.emulation?.orientation).toBe("landscape");
        yield* run((fields) => ({
          _tag: "emulate",
          ...fields,
          change: { _tag: "location", latitude: 37.33, longitude: -122.03 },
        }));
        // The agent cannot change the simulator while the user holds it.
        const refused = yield* Effect.flip(
          run(
            (fields) => ({
              _tag: "emulate",
              ...fields,
              change: { _tag: "appearance", appearance: "light" },
            }),
            "agent"
          )
        );
        expect(refused.code).toBe("ios_workspace_refused");
        // An app the observer cannot name pauses input but not Teaching.
        unknown = true;
        yield* Effect.flip(
          workspace.execute(
            { _tag: "observe", image: false, sessionId: started.id },
            "agent"
          )
        );
        const paused = yield* workspace.execute(
          { _tag: "read", sessionId: started.id },
          "agent"
        );
        expect(paused).toMatchObject({
          captureGaps: [],
          captureState: { _tag: "recording" },
          phase: "paused",
          refusal: { code: "foreground_app_unknown", recovery: "go-home" },
        });
        // Going Home is safe for the agent too.
        const resumed = yield* run(
          (fields) => ({ _tag: "recover", ...fields }),
          "agent"
        );
        expect(recoveries).toBe(1);
        expect(resumed).toMatchObject({
          captureState: { _tag: "recording" },
          phase: "running",
          refusal: null,
        });
        yield* run((fields) => ({ _tag: "close", ...fields }));
        expect(device.calls).toEqual([
          "home",
          "app-switcher",
          `simctl ui ${udid} appearance dark`,
          "rotate landscape",
          `simctl location ${udid} set 37.33,-122.03`,
          // The session's end puts back what it found.
          "rotate portrait",
          `simctl ui ${udid} appearance light`,
          `simctl location ${udid} clear`,
        ]);
      }).pipe(Effect.provide(Layer.merge(storeLayer, workspaceLayer)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
