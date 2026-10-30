import type { PlatformCapability } from "@contingency/protocol";
import type { Effect as EffectType } from "effect";
import { Effect, Redacted, Scope, Semaphore } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { nativeAppRuntimeError } from "./native-app-error.ts";
import type {
  NativeAppRuntimeStartInput,
  NativeAppRuntimeBackend,
  NativeAppRuntime,
  NativeAppRuntimeState,
  NativeAppVariableFillRequest,
  NativeAppActionPolicy,
} from "./native-app-runtime-contract.ts";
import type {
  PlatformAction,
  PlatformObservation,
  PlatformRuntimeError,
} from "./platform-runtime.ts";

export const requireNativeAppCapabilities = (
  required: readonly PlatformCapability[],
  available: readonly PlatformCapability[],
  error: typeof nativeAppRuntimeError = nativeAppRuntimeError
) => {
  const supported = new Set(available);
  return required.every((capability) => supported.has(capability))
    ? Effect.void
    : Effect.fail(error("capability_missing"));
};

export const adaptNativeAppRuntime = <
  Observation extends PlatformObservation,
  Device,
>(input: {
  readonly startup: NativeAppRuntimeStartInput<Device>;
  readonly backend: NativeAppRuntimeBackend<Observation>;
  readonly capabilities: readonly PlatformCapability[];
  readonly policy: NativeAppActionPolicy<Observation>;
  readonly error?: typeof nativeAppRuntimeError;
}): EffectType.Effect<
  NativeAppRuntime<Observation, Device>,
  PlatformRuntimeError
> =>
  Effect.gen(function* adaptAndroid() {
    const error = input.error ?? nativeAppRuntimeError;
    yield* requireNativeAppCapabilities(
      input.startup.requiredCapabilities,
      input.capabilities,
      error
    );
    const registry = AtomRegistry.make();
    const status = Atom.make<NativeAppRuntimeState>({
      failure: null,
      observationId: null,
      outcome: "none",
      phase: "ready",
    }).pipe(Atom.keepAlive);
    const observation = Atom.make<Observation | null>(null).pipe(
      Atom.keepAlive
    );
    const lock = Semaphore.makeUnsafe(1);
    registry.get(status);
    registry.get(observation);
    let terminal: NativeAppRuntimeState | undefined;
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
        Effect.onInterrupt(() => pause(error("execution_canceled")))
      );
    const requireReady = Effect.suspend(() =>
      state().phase === "ready"
        ? Effect.void
        : Effect.fail(error("runtime_paused"))
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
              return yield* Effect.fail(error("observation_stale"));
            }
            // Consume before validation or dispatch, including unsupported requests.
            yield* invalidate;
            if (action.type === "coordinate" || action.type === "press") {
              return yield* Effect.fail(error("capability_missing"));
            }
            yield* input.policy.publicAction(captured, action);
            yield* input.backend.validate();
            registry.update(status, (current) => ({
              ...current,
              outcome: "uncertain" as const,
            }));
            if (action.type === "back") {
              if (input.backend.back === undefined) {
                return yield* Effect.fail(error("capability_missing"));
              }
              yield* input.backend.back();
            } else if (action.type === "activate") {
              yield* input.backend.activate(action.target);
            } else {
              const result = yield* input.backend.fill(
                action.target,
                action.text
              );
              yield* input.backend.validate();
              // agent-device accepts masked text by length alone, which proves nothing.
              const masked =
                input.policy.unconfirmedFill?.(captured, action.target) ??
                false;
              return masked
                ? { ...result, confirmation: "unconfirmed" as const }
                : result;
            }
            yield* input.backend.validate();
            // A successful dispatch is still uncertain until independently observed.
          })
        )
      );
    const enterVariable = (id: string, request: NativeAppVariableFillRequest) =>
      Effect.gen(function* fillVariable() {
        const text = Redacted.value(yield* request.value);
        const result = yield* mutate(id, {
          target: request.target,
          text,
          type: "fill",
        });
        return {
          confirmation: result?.confirmation ?? "unconfirmed",
          outcome: "entered" as const,
          variable: request.variable,
        };
      });
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
      capabilities: input.capabilities,
      close: () => close,
      device: input.startup.device,
      dispatch: mutate,
      enterVariable,
      invalidate: () => lock.withPermits(1)(invalidate),
      observe: () =>
        lock.withPermits(1)(
          guarded(requireReady.pipe(Effect.andThen(capture)))
        ),
      platform: input.startup.platform,
      recover: () =>
        lock.withPermits(1)(
          guarded(
            Effect.gen(function* recoverAndroid() {
              if (state().phase === "closed") {
                return yield* Effect.fail(error("runtime_closed"));
              }
              yield* input.backend.recover();
              return yield* capture;
            })
          )
        ),
      state,
    };
  });
