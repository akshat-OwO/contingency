import type { Effect as EffectType } from "effect";
import { Effect } from "effect";

import { preflightAndroidPreparation } from "./android-preparation.ts";
import { createAndroidRun } from "./android-run.ts";
import { acquireAndroidBackend } from "./android-runtime-backend.ts";
import { androidCapabilities } from "./android-runtime-contract.ts";
import type {
  AndroidPlatformRuntime,
  AndroidRuntimeBackend,
  AndroidRuntimeFactoryService,
  AndroidRuntimeStartInput,
} from "./android-runtime-contract.ts";
import { validateAndroidStartup } from "./android-startup.ts";
import { adaptNativeAppRuntime } from "./native-app-runtime.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const publicTextPattern = /^[\u0020-\u007E]*$/u;

export const adaptAndroidRuntime = (input: {
  readonly startup: AndroidRuntimeStartInput;
  readonly backend: AndroidRuntimeBackend;
}): EffectType.Effect<AndroidPlatformRuntime, PlatformRuntimeError> =>
  adaptNativeAppRuntime({
    ...input,
    capabilities: androidCapabilities,
    error: platformRuntimeError,
    policy: {
      privateTarget: (captured, request) =>
        Effect.gen(function* validatePrivateTarget() {
          const node = captured.nodes.find(
            (candidate) => candidate.target === request.target
          );
          if (
            node === undefined ||
            node.packageName !== input.startup.targetApp ||
            node.covered ||
            !node.editable ||
            !node.password
          ) {
            return yield* Effect.fail(
              platformRuntimeError("target_unsupported")
            );
          }
        }),
      publicAction: (captured, action) =>
        Effect.gen(function* validatePublicAction() {
          if (
            action.type !== "back" &&
            action.type !== "coordinate" &&
            action.type !== "press"
          ) {
            const node = captured.nodes.find(
              (candidate) => candidate.target === action.target
            );
            if (
              node === undefined ||
              node.packageName !== input.startup.targetApp ||
              node.covered ||
              node.password ||
              (action.type === "fill" && !node.editable)
            ) {
              return yield* Effect.fail(
                platformRuntimeError("target_unsupported")
              );
            }
          }
          if (action.type === "fill" && !publicTextPattern.test(action.text)) {
            return yield* Effect.fail(
              platformRuntimeError("target_unsupported")
            );
          }
        }),
    },
  }).pipe(
    Effect.map((runtime) => ({ ...runtime, platform: "android" as const }))
  );

export const makeAndroidRuntimeFactory = (): AndroidRuntimeFactoryService => ({
  capabilities: androidCapabilities,
  createRun: (input) =>
    createAndroidRun(input, {
      preflight: preflightAndroidPreparation,
      start: (startup) =>
        Effect.gen(function* startPrepared() {
          const backend = yield* acquireAndroidBackend(startup, startup);
          return yield* adaptAndroidRuntime({ backend, startup });
        }),
    }),
  platform: "android",
  start: (request) =>
    Effect.gen(function* startAndroid() {
      const startup = Object.freeze({
        ...request,
        device: Object.freeze({ ...request.device }),
        requiredCapabilities: Object.freeze([...request.requiredCapabilities]),
      });
      yield* validateAndroidStartup(startup);
      const backend = yield* acquireAndroidBackend(startup);
      return yield* adaptAndroidRuntime({ backend, startup });
    }),
});
