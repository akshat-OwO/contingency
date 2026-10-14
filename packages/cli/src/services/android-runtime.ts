import type { Effect as EffectType } from "effect";
import { Effect, Scope, Semaphore } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { preflightAndroidPreparation } from "./android-preparation.ts";
import { createAndroidRun } from "./android-run.ts";
import { acquireAndroidBackend } from "./android-runtime-backend.ts";
import { androidCapabilities } from "./android-runtime-contract.ts";
import type {
  AndroidObservation,
  AndroidPlatformRuntime,
  AndroidPrivateTextRequest,
  AndroidRuntimeBackend,
  AndroidRuntimeFactoryService,
  AndroidRuntimeStartInput,
  AndroidRuntimeState,
} from "./android-runtime-contract.ts";
import { validateAndroidStartup } from "./android-startup.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type {
  PlatformAction,
  PlatformRuntimeError,
} from "./platform-runtime.ts";

const publicTextPattern = /^[\u0020-\u007E]*$/u;

export const adaptAndroidRuntime = (input: {
  readonly startup: AndroidRuntimeStartInput;
  readonly backend: AndroidRuntimeBackend;
}): EffectType.Effect<AndroidPlatformRuntime> =>
  Effect.gen(function* adaptAndroid() {
    const registry = AtomRegistry.make();
    const status = Atom.make<AndroidRuntimeState>({
      failure: null,
      observationId: null,
      outcome: "none",
      phase: "ready",
    }).pipe(Atom.keepAlive);
    const observation = Atom.make<AndroidObservation | null>(null).pipe(
      Atom.keepAlive
    );
    const lock = Semaphore.makeUnsafe(1);
    registry.get(status);
    registry.get(observation);
    let terminal: AndroidRuntimeState | undefined;
    const state = () => terminal ?? registry.get(status);
    const invalidate = Effect.sync(() => {
      if (terminal !== undefined) {
        return;
      }
      registry.set(observation, null);
      registry.update(status, (current) => ({
        ...current,
        observationId: null,
      }));
    });
    const pause = (failure: PlatformRuntimeError) =>
      Effect.sync(() => {
        if (terminal !== undefined) {
          return;
        }
        registry.set(observation, null);
        registry.update(status, (current) => ({
          ...current,
          failure,
          observationId: null,
          phase: "paused" as const,
        }));
      });
    const guarded = <A>(effect: EffectType.Effect<A, PlatformRuntimeError>) =>
      effect.pipe(
        Effect.tapError(pause),
        Effect.onInterrupt(() =>
          pause(platformRuntimeError("execution_canceled"))
        )
      );
    const requireReady = Effect.suspend(() =>
      state().phase === "ready"
        ? Effect.void
        : Effect.fail(platformRuntimeError("runtime_paused"))
    );
    const capture = Effect.gen(function* observeAndroid() {
      yield* invalidate;
      yield* input.backend.validate();
      const captured = yield* input.backend.capture();
      registry.set(observation, captured);
      registry.set(status, {
        failure: null,
        observationId: captured.id,
        outcome: "observed",
        phase: "ready",
      });
      return captured;
    });
    const mutate = (
      id: string,
      action: PlatformAction | { readonly type: "back" }
    ) =>
      lock.withPermits(1)(
        guarded(
          Effect.gen(function* dispatchAndroid() {
            yield* requireReady;
            const captured = registry.get(observation);
            if (captured === null || captured.id !== id) {
              return yield* Effect.fail(
                platformRuntimeError("observation_stale")
              );
            }
            // Consume before validation or dispatch, including unsupported requests.
            yield* invalidate;
            if (action.type === "coordinate" || action.type === "press") {
              return yield* Effect.fail(
                platformRuntimeError("capability_missing")
              );
            }
            if (action.type !== "back") {
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
            if (
              action.type === "fill" &&
              !publicTextPattern.test(action.text)
            ) {
              return yield* Effect.fail(
                platformRuntimeError("target_unsupported")
              );
            }
            yield* input.backend.validate();
            registry.update(status, (current) => ({
              ...current,
              outcome: "uncertain" as const,
            }));
            if (action.type === "back") {
              yield* input.backend.back();
            } else if (action.type === "activate") {
              yield* input.backend.activate(action.target);
            } else {
              yield* input.backend.fill(action.target, action.text);
            }
            yield* input.backend.validate();
            // A successful dispatch is still uncertain until independently observed.
          })
        )
      );
    const privateText =
      input.startup.requiredCapabilities.includes("private-input");
    const enterPrivate = (id: string, request: AndroidPrivateTextRequest) =>
      lock.withPermits(1)(
        guarded(
          Effect.gen(function* enterAndroidPrivate() {
            yield* requireReady;
            const captured = registry.get(observation);
            if (captured === null || captured.id !== id) {
              return yield* Effect.fail(
                platformRuntimeError("observation_stale")
              );
            }
            yield* invalidate;
            if (!privateText) {
              return yield* Effect.fail(
                platformRuntimeError("capability_missing")
              );
            }
            const node = captured.nodes.find(
              (candidate) => candidate.target === request.target
            );
            if (
              node === undefined ||
              node.packageName !== input.startup.targetApp ||
              node.covered ||
              !node.editable ||
              // Captures redact only password fields; a value elsewhere would be exported.
              !node.password
            ) {
              return yield* Effect.fail(
                platformRuntimeError("target_unsupported")
              );
            }
            yield* input.backend.validate();
            registry.update(status, (current) => ({
              ...current,
              outcome: "uncertain" as const,
            }));
            // The helper resolves the value only after it binds the field.
            yield* input.backend.enterPrivate(request.target, request.value);
            yield* input.backend.validate();
            return { outcome: "verified" as const, variable: request.variable };
          })
        )
      );
    const close = lock.withPermits(1)(
      Effect.gen(function* closeAndroid() {
        if (state().phase === "closed") {
          return;
        }
        yield* invalidate;
        const result = yield* Effect.result(input.backend.close());
        registry.update(status, (current) => ({
          ...current,
          failure: result._tag === "Failure" ? result.failure : current.failure,
          phase: "closed" as const,
        }));
        terminal = registry.get(status);
        registry.dispose();
      })
    );
    // Retain the terminal state for callers inspecting cleanup failures.
    yield* Scope.addFinalizer(input.startup.scope, close);
    return {
      back: (id) => mutate(id, { type: "back" }),
      backendSessionId: input.backend.sessionId,
      capabilities: privateText
        ? androidCapabilities
        : androidCapabilities.filter(
            (capability) => capability !== "private-input"
          ),
      close: () => close,
      device: input.startup.device,
      dispatch: mutate,
      enterPrivate,
      experimental: true,
      invalidate: () => lock.withPermits(1)(invalidate),
      observe: () =>
        lock.withPermits(1)(
          guarded(requireReady.pipe(Effect.andThen(capture)))
        ),
      platform: "android",
      recover: () =>
        lock.withPermits(1)(
          guarded(
            Effect.gen(function* recoverAndroid() {
              if (state().phase === "closed") {
                return yield* Effect.fail(
                  platformRuntimeError("runtime_closed")
                );
              }
              yield* input.backend.recover();
              return yield* capture;
            })
          )
        ),
      state,
    };
  });

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
