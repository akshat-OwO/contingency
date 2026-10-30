import { expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";

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
  "refuses an absent Back capability and invalidates its observation",
  () =>
    Effect.gen(function* refuseBack() {
      const { input } = fixture(yield* Scope.Scope);
      const runtime = yield* adaptNativeAppRuntime(input);
      yield* runtime.observe();
      expect((yield* Effect.flip(runtime.back(observation.id))).code).toBe(
        "capability_missing"
      );
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
