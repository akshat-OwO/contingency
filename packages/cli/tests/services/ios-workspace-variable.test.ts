import { FlowName, OperationId } from "@contingency/protocol";
import type {
  AgentSessionId,
  IosWorkspaceCommand,
  IosWorkspaceSelection,
  NativeInput,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Layer, Result, Stream } from "effect";
import { TestClock } from "effect/testing";

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
import type { IosWorkspaceService } from "../../src/services/ios-workspace.ts";
import { nativeAppActionPolicy } from "../../src/services/native-app-action-policy.ts";
import type { NativeAppRunDecision } from "../../src/services/native-app-run-contract.ts";
import { createNativeAppRun } from "../../src/services/native-app-run.ts";
import { adaptNativeAppRuntime } from "../../src/services/native-app-runtime.ts";
import { SETTLE_MILLIS } from "../../src/services/native-forwarded-lane.ts";
import { makeTeachingRecordingStoreLayer } from "../../src/services/teaching-recording-store.ts";

type Nodes = IosObservation["nodes"];

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

/** A portrait screenshot's header: only its size is read. */
const screenshot = () => {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(1206, 16);
  bytes.writeUInt32BE(2622, 20);
  return bytes.toString("base64");
};
/** The Password field, in screenshot pixels. */
const passwordBounds = { height: 102, width: 1062, x: 72, y: 690 };

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

const key = (name: string): readonly [NativeInput, NativeInput] => [
  { _tag: "key", action: "down", at: 0, code: "", key: name, modifiers: 0 },
  { _tag: "key", action: "up", at: 0, code: "", key: name, modifiers: 0 },
];
const tap = (x: number, y: number): readonly [NativeInput, NativeInput] => [
  { _tag: "touch", action: "down", at: 0, x, y },
  { _tag: "touch", action: "up", at: 0, x, y },
];

/** The login screen, as each capture lists it. */
const loginScreen = (generation: number): Nodes => [
  {
    bounds: { height: 102, width: 1062, x: 72, y: 524 },
    covered: false,
    editable: true,
    hittable: true,
    name: "Login name",
    packageName: "dev.contingency.ioslogin",
    password: false,
    role: "text-field",
    target: `@e1~s${generation}`,
  },
  {
    bounds: passwordBounds,
    covered: false,
    editable: true,
    hittable: true,
    name: "Password",
    packageName: "dev.contingency.ioslogin",
    password: true,
    role: "secure-text-field",
    target: `@e2~s${generation}`,
  },
];

interface Teaching {
  readonly workspace: IosWorkspaceService;
  readonly sessionId: AgentSessionId;
  readonly run: (
    command: (fields: {
      readonly operationId: OperationId;
      readonly sessionId: AgentSessionId;
    }) => IosWorkspaceCommand
  ) => ReturnType<IosWorkspaceService["execute"]>;
  /** Holds the next capture until released, as a slow simulator read does. */
  readonly hold: () => Effect.Effect<{
    readonly started: Deferred.Deferred<boolean>;
    readonly release: Deferred.Deferred<boolean>;
  }>;
}

/**
 * A recording Teaching session on a fake simulator. `screen` lists what each
 * capture shows; `held` is true for a capture `hold` delayed.
 */
const teachLogin = <A, E>(
  screen: (generation: number, held: boolean) => Nodes,
  scenario: (teaching: Teaching) => Effect.Effect<A, E, never>
) =>
  Effect.gen(function* teachOnFakeSimulator() {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    let generation = 0;
    // The next capture waits here, as a slow simulator read does.
    let held:
      | {
          readonly started: Deferred.Deferred<boolean>;
          readonly release: Deferred.Deferred<boolean>;
        }
      | undefined;
    const fills: string[] = [];
    const activations: string[] = [];
    const capture = () =>
      Effect.gen(function* captureFixture() {
        const gate = held;
        held = undefined;
        if (gate !== undefined) {
          yield* Deferred.succeed(gate.started, true);
          yield* Deferred.await(gate.release);
        }
        generation += 1;
        return {
          appId: "dev.contingency.ioslogin",
          backendSessionId: "fixture-session",
          device: simulator,
          generation,
          id: `observation-${generation}`,
          nodes: screen(generation, gate !== undefined),
          platform: "ios",
          screenshot: {
            capturedAt: "2026-11-18T00:00:00.000Z",
            encoding: "base64",
            format: "png",
            image: screenshot(),
          },
        } satisfies IosObservation;
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
                fill: (target) =>
                  Effect.sync(() => {
                    fills.push(target);
                    return {
                      confirmation: "unconfirmed" as const,
                      outcome: "entered" as const,
                    };
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
    const storeLayer = makeTeachingRecordingStoreLayer({ root: () => root });
    const workspaceLayer = makeIosWorkspaceLayer({
      acquireStream: () => Effect.succeed(fakeStream()),
      booted: () => Effect.succeed(true),
      createRun,
      makeHid: () => Effect.succeed({ forward: () => Effect.void }),
      root: () => root,
      simctl: () => Effect.succeed("light"),
    }).pipe(
      Layer.provide(Layer.merge(storeLayer, makeFlowCatalogLayer({ root })))
    );
    return yield* Effect.gen(function* teach() {
      const workspace = yield* IosWorkspace;
      const started = yield* workspace.execute(
        {
          _tag: "start",
          flowName: FlowName.make("variable"),
          kind: "teaching",
          operationId: OperationId.make("variable-start"),
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
        }) => IosWorkspaceCommand
      ) => {
        step += 1;
        return workspace.execute(
          command({
            operationId: OperationId.make(`variable-${step}`),
            sessionId: started.id,
          }),
          "user"
        );
      };
      yield* run((fields) => ({ _tag: "prepare", ...fields }));
      yield* run((fields) => ({ _tag: "record", ...fields, start: true }));
      const result = yield* scenario({
        hold: () =>
          Effect.gen(function* holdNextCapture() {
            const gate = {
              release: yield* Deferred.make<boolean>(),
              started: yield* Deferred.make<boolean>(),
            };
            held = gate;
            return gate;
          }),
        run,
        sessionId: started.id,
        workspace,
      });
      const read = yield* workspace.execute(
        { _tag: "read", sessionId: started.id },
        "user"
      );
      yield* run((fields) => ({ _tag: "close", ...fields }));
      return { activations, fills, phase: read.phase, result };
    }).pipe(Effect.provide(Layer.merge(storeLayer, workspaceLayer)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/**
 * The user types, then taps Password while the observation of that typing is
 * still being captured; `overtaken` is what that late capture lists. The
 * Workspace discards it, but it is the runtime's latest.
 */
const enterAfterOvertakenSettle = (overtaken: (nodes: Nodes) => Nodes) =>
  teachLogin(
    (generation, held) =>
      held ? overtaken(loginScreen(generation)) : loginScreen(generation),
    ({ hold, run, sessionId, workspace }) =>
      Effect.gen(function* passwordAfterOvertakenSettle() {
        // Typing settles into an observation the simulator is slow to give.
        const gate = yield* hold();
        yield* workspace.forward({ inputs: key("a"), sessionId }, "user");
        yield* TestClock.adjust(SETTLE_MILLIS);
        yield* Deferred.await(gate.started);
        // The user taps Password before that observation lands, so the
        // Workspace discards it; the runtime still captured it.
        yield* workspace.forward(
          {
            inputs: tap(
              0.5,
              (passwordBounds.y + passwordBounds.height / 2) / 2622
            ),
            sessionId,
          },
          "user"
        );
        yield* Deferred.succeed(gate.release, true);

        const requested = yield* run((fields) => ({
          _tag: "variable-request",
          ...fields,
          name: "PASSWORD",
          purpose: "Input for Password",
          replace: false,
        }));
        const { field } = requested;
        const request = requested.variables?.find(
          (variable) => variable.name === "PASSWORD"
        );
        expect(field?.password).toBe(true);
        if (field === null || field === undefined || request === undefined) {
          return yield* Effect.die("The tapped Password field must be bound");
        }
        yield* run((fields) => ({
          _tag: "variable-supply",
          ...fields,
          name: "PASSWORD",
          requestId: request.requestId,
          value: "secret",
        }));
        const entered = yield* Effect.result(
          run((fields) => ({
            _tag: "input",
            ...fields,
            action: {
              _tag: "variable",
              name: "PASSWORD",
              target: field.target,
            },
            observationId: field.observationId,
          }))
        );
        return entered;
      })
  ).pipe(
    Effect.map(({ fills, phase, result }) => ({
      entered: result,
      fills,
      phase,
    }))
  );

it.effect(
  "enters a Variable into a password field tapped while an earlier observation was settling",
  () =>
    Effect.gen(function* unchangedScreen() {
      // The same screen, listed as XCTest lists it from one capture to the
      // next: another order, off-screen keyboard keys, and a container.
      const { entered, fills, phase } = yield* enterAfterOvertakenSettle(
        (nodes) => [
          {
            bounds: { height: 0, width: 0, x: 0, y: 2856 },
            covered: true,
            editable: false,
            hittable: false,
            name: "Padding-Left",
            packageName: "dev.contingency.ioslogin",
            password: false,
            role: "key",
            target: "@e9~s9",
          },
          {
            bounds: { height: 2622, width: 1206, x: 0, y: 0 },
            covered: false,
            editable: false,
            hittable: false,
            name: "Login fixture",
            packageName: "dev.contingency.ioslogin",
            password: false,
            role: "other",
            target: "@e8~s9",
          },
          ...nodes.toReversed(),
        ]
      );
      expect(Result.isSuccess(entered)).toBe(true);
      expect(phase).toBe("running");
      expect(fills).toHaveLength(1);
    })
);

it.effect(
  "refuses the Variable when the latest capture shows another screen",
  () =>
    Effect.gen(function* changedScreen() {
      const { entered, fills, phase } = yield* enterAfterOvertakenSettle(
        (nodes) => [
          ...nodes,
          {
            bounds: { height: 120, width: 600, x: 300, y: 1200 },
            covered: false,
            editable: false,
            hittable: true,
            name: "Allow Paste",
            packageName: "com.apple.springboard",
            password: false,
            role: "button",
            target: "@e7~s9",
          },
        ]
      );
      expect(Result.isFailure(entered)).toBe(true);
      expect(phase).toBe("running");
      expect(fills).toHaveLength(0);
    })
);

/** The App Switcher: a card that shares its role and name with containers. */
const switcher = (generation: number): Nodes =>
  [
    { height: 2622, width: 1206, x: 0, y: 0 },
    { height: 2622, width: 1206, x: 0, y: 0 },
    { height: 1769, width: 814, x: 30, y: 400 },
  ].map((bounds, index) => ({
    bounds,
    covered: false,
    editable: false,
    hittable: false,
    name: "Contingency Public Login",
    packageName: "com.apple.springboard",
    password: false,
    role: "other",
    target: `@e${index + 1}~s${generation}`,
  }));

it.effect(
  "activates the one of several same-named controls at the selected position",
  () =>
    Effect.gen(function* switcherCard() {
      const { activations, phase, result } = yield* teachLogin(
        (generation) => switcher(generation),
        ({ run, sessionId, workspace }) =>
          Effect.gen(function* activateCard() {
            const shown = yield* workspace.execute(
              { _tag: "observe", image: false, sessionId },
              "user"
            );
            const card = shown.observation?.nodes.at(2);
            if (
              shown.observation === null ||
              shown.observation === undefined ||
              card === undefined
            ) {
              return yield* Effect.die("The switcher must be observed");
            }
            const observationId = shown.observation.id;
            return yield* Effect.result(
              run((fields) => ({
                _tag: "input",
                ...fields,
                action: { _tag: "activate", target: card.target },
                observationId,
              }))
            );
          })
      );
      expect(Result.isSuccess(result)).toBe(true);
      expect(phase).toBe("running");
      // The card, captured again before dispatch, not a container.
      expect(activations).toHaveLength(1);
      expect(activations[0]).toMatch(/^@e3~s/u);
    })
);
