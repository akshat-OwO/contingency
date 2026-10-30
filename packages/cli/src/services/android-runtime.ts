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
import { nativeAppActionPolicy } from "./native-app-action-policy.ts";
import { adaptNativeAppRuntime } from "./native-app-runtime.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

export const adaptAndroidRuntime = (input: {
  readonly startup: AndroidRuntimeStartInput;
  readonly backend: AndroidRuntimeBackend;
}): EffectType.Effect<AndroidPlatformRuntime, PlatformRuntimeError> =>
  adaptNativeAppRuntime({
    ...input,
    capabilities: androidCapabilities,
    error: platformRuntimeError,
    policy: nativeAppActionPolicy(platformRuntimeError, true),
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
