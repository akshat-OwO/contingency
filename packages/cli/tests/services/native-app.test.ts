import { expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";

import { iosRuntimeError } from "../../src/services/ios-runtime.ts";
import {
  compareNativeAppEnvironments,
  nativeAppEnvironmentPermission,
} from "../../src/services/native-app-environment.ts";
import type {
  NativeAppRunInput,
  NativeAppRunDecision,
} from "../../src/services/native-app-run-contract.ts";
import { createNativeAppRun } from "../../src/services/native-app-run.ts";
import type {
  NativeAppRuntimeBackend,
  NativeAppRuntimeStartInput,
} from "../../src/services/native-app-runtime-contract.ts";
import { adaptNativeAppRuntime } from "../../src/services/native-app-runtime.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";
import { makePlatformRuntimeFactory } from "../../src/services/platform-runtime.ts";
import type { PlatformObservation } from "../../src/services/platform-runtime.ts";

const observation: PlatformObservation = {
  id: "observed",
  nodes: [{ name: "Open", role: "button", target: "button" }],
  platform: "android",
  screenshot: {
    capturedAt: "2026-10-27",
    encoding: "base64",
    format: "png",
    image: "pixels",
  },
};
const startup = (scope: Scope.Scope): NativeAppRuntimeStartInput => ({
  device: { id: "selected" },
  platform: "android",
  requiredCapabilities: ["semantic-actions", "screenshots"],
  scope,
  targetApp: "fixture",
});
const fixture = (scope: Scope.Scope) => {
  const calls: string[] = [];
  const backend: NativeAppRuntimeBackend<PlatformObservation> = {
    activate: () =>
      Effect.sync(() => {
        calls.push("activate");
      }),
    capture: () => Effect.succeed(observation),
    close: () =>
      Effect.sync(() => {
        calls.push("close");
      }),
    fill: () =>
      Effect.succeed({ confirmation: "confirmed", outcome: "entered" }),
    recover: () => Effect.void,
    sessionId: "owned",
    validate: () => Effect.void,
  };
  return {
    calls,
    input: {
      backend,
      capabilities: ["semantic-actions", "screenshots"] as const,
      policy: {
        publicAction: () => Effect.void,
      },
      startup: startup(scope),
    },
  };
};

it.effect("refuses iOS before invoking any platform implementation", () =>
  Effect.gen(function* refuseUnavailablePlatform() {
    let calls = 0;
    const unused = () =>
      Effect.sync(() => {
        calls += 1;
      }).pipe(
        Effect.andThen(Effect.fail(platformRuntimeError("runtime_failed")))
      );
    const factory = makePlatformRuntimeFactory(
      {
        capabilities: [],
        platform: "web",
        start: () => Effect.die("Unexpected browser startup"),
      },
      {
        capabilities: [],
        createRun: unused,
        platform: "android",
        start: unused,
      }
    );
    const failure = yield* Effect.flip(
      factory.start({ ...startup(yield* Scope.Scope), platform: "ios" })
    );
    expect(failure).toMatchObject({
      _tag: "PlatformRuntimeError",
      code: "capability_missing",
    });
    expect(calls).toBe(0);
  })
);

it.effect("refuses a required capability before acquiring runtime state", () =>
  Effect.gen(function* refuseMissingCapability() {
    const { input, calls } = fixture(yield* Scope.Scope);
    const failure = yield* Effect.flip(
      adaptNativeAppRuntime({
        ...input,
        startup: {
          ...input.startup,
          requiredCapabilities: ["teaching-capture"],
        },
      })
    );
    expect(failure.code).toBe("capability_missing");
    expect(calls).toEqual([]);
  })
);

it.effect("consumes action observations and closes a scoped runtime once", () =>
  Effect.gen(function* consumeAndClose() {
    const scope = yield* Scope.make();
    const { input, calls } = fixture(scope);
    const runtime = yield* adaptNativeAppRuntime(input);
    yield* runtime.observe();
    yield* runtime.dispatch(observation.id, {
      target: "button",
      type: "activate",
    });
    expect(runtime.state().outcome).toBe("uncertain");
    const failure = yield* Effect.flip(
      runtime.dispatch(observation.id, { target: "button", type: "activate" })
    );
    expect(failure.code).toBe("observation_stale");
    expect(runtime.state().phase).toBe("paused");
    yield* runtime.recover();
    expect(runtime.state().phase).toBe("ready");
    yield* Scope.close(scope, Exit.void);
    yield* runtime.close();
    expect(calls).toEqual(["activate", "close"]);
    expect(runtime.state().phase).toBe("closed");
  })
);

it.effect(
  "refuses an absent system key capability and invalidates its observation",
  () =>
    Effect.gen(function* refuseBack() {
      const { input } = fixture(yield* Scope.Scope);
      const runtime = yield* adaptNativeAppRuntime(input);
      yield* runtime.observe();
      expect(
        (yield* Effect.flip(runtime.systemKey(observation.id, "back"))).code
      ).toBe("capability_missing");
      expect(runtime.state()).toMatchObject({
        observationId: null,
        phase: "paused",
      });
    })
);

it.effect(
  "Run permission gates preparation and preserves taught requirements",
  () =>
    Effect.gen(function* gatePreparation() {
      const scope = yield* Scope.Scope;
      const { input, calls } = fixture(scope);
      const request = {
        ...startup(scope),
        environment: { build: "new" },
        setup: { fresh: true },
        taught: { build: "old" },
      } satisfies NativeAppRunInput;
      const run = yield* createNativeAppRun<
        typeof request,
        PlatformObservation,
        NativeAppRunDecision
      >(request, {
        authorize: (selected) => selected,
        decisions: (selected, runId, differences) =>
          nativeAppEnvironmentPermission({
            differences,
            requiresPermission: () => true,
            runId,
            targetApp: selected.targetApp,
          }),
        differences: (selected) =>
          compareNativeAppEnvironments({
            display: (_field, value) => String(value),
            fields: ["build"],
            selected: selected.environment,
            taught: selected.taught,
          }),
        preflight: () => Effect.void,
        start: () =>
          Effect.sync(() => {
            calls.push("prepare");
          }).pipe(Effect.andThen(adaptNativeAppRuntime(input))),
        startingConditions: () => true,
        validate: () => Effect.void,
      });
      expect((yield* Effect.flip(run.prepare())).code).toBe(
        "preparation_required"
      );
      expect(calls).toEqual([]);
      const [decision] = run.state().pending;
      expect(decision?.kind).toBe("run-environment-permission");
      yield* run.decide(decision?.id ?? "missing", true);
      yield* run.prepare();
      expect(calls).toEqual(["prepare"]);
      expect(run.state()).toMatchObject({
        environment: { build: "new" },
        pending: [],
        phase: "ready",
        taught: { build: "old" },
      });
      expect(
        (yield* Effect.flip(run.decide(decision?.id ?? "missing", true))).code
      ).toBe("permission_stale");
    })
);

it.effect(
  "pauses native input while no app can be named in front until explicit recovery",
  () =>
    Effect.gen(function* unknownForegroundRecovery() {
      const { input, calls } = fixture(yield* Scope.Scope);
      let foreign = false;
      let recoveries = 0;
      const runtime = yield* adaptNativeAppRuntime({
        ...input,
        backend: {
          ...input.backend,
          capture: () =>
            foreign
              ? Effect.fail(iosRuntimeError("foreground_app_unknown"))
              : Effect.succeed(observation),
          recover: () =>
            Effect.sync(() => {
              foreign = false;
              recoveries += 1;
            }),
        },
        startup: { ...input.startup, platform: "ios" },
      });
      yield* runtime.observe();
      foreign = true;
      expect((yield* Effect.flip(runtime.observe())).code).toBe(
        "foreground_app_unknown"
      );
      expect(runtime.state()).toMatchObject({
        failure: { code: "foreground_app_unknown" },
        observationId: null,
        phase: "paused",
      });
      expect(
        (yield* Effect.flip(
          runtime.dispatch(observation.id, {
            target: "button",
            type: "activate",
          })
        )).code
      ).toBe("runtime_paused");
      expect(calls).toEqual([]);
      yield* runtime.recover();
      expect(recoveries).toBe(1);
      expect(runtime.state()).toMatchObject({ failure: null, phase: "ready" });
      yield* runtime.dispatch(observation.id, {
        target: "button",
        type: "activate",
      });
      expect(calls).toEqual(["activate"]);
    })
);

it.effect(
  "preparation settles the device before it checks the Flow's starting conditions",
  () =>
    Effect.gen(function* settleBeforeConditions() {
      const scope = yield* Scope.Scope;
      const { input } = fixture(scope);
      // A screen that names its node only in landscape; the device starts portrait.
      let orientation: "portrait" | "landscape" = "portrait";
      const calls: string[] = [];
      const request = {
        ...startup(scope),
        environment: {},
        setup: {},
        taught: {},
      } satisfies NativeAppRunInput;
      const run = yield* createNativeAppRun<
        typeof request,
        PlatformObservation,
        NativeAppRunDecision
      >(request, {
        authorize: (selected) => selected,
        decisions: () => [],
        differences: () => [],
        preflight: () => Effect.void,
        start: () =>
          adaptNativeAppRuntime({
            ...input,
            backend: {
              ...input.backend,
              capture: () =>
                Effect.sync(() => {
                  calls.push(`observe ${orientation}`);
                  return {
                    ...observation,
                    nodes: [
                      {
                        name:
                          orientation === "landscape"
                            ? "landscape only"
                            : "portrait",
                        role: "text",
                        target: "text",
                      },
                    ],
                  };
                }),
              rotate: (next) =>
                Effect.sync(() => {
                  calls.push(`rotate ${next}`);
                  orientation = next;
                }),
            },
          }),
        startingConditions: (_, observed) =>
          observed.nodes.some((node) => node.name === "landscape only"),
        validate: () => Effect.void,
      });
      // Without settling, the portrait screen fails the gate.
      const prepared = yield* run.prepare((launched) => {
        expect(launched.nodes[0]?.name).toBe("portrait");
        // The settle step may rotate while preparation holds the run.
        return run.rotate("landscape");
      });
      expect(prepared.nodes[0]?.name).toBe("landscape only");
      expect(calls).toEqual([
        "observe portrait",
        "rotate landscape",
        "observe landscape",
      ]);
      expect(run.state().phase).toBe("ready");
    })
);
