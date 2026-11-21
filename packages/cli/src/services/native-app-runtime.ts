import type { PlatformCapability } from "@contingency/protocol";
import type { Effect as EffectType } from "effect";
import { Clock, Effect, Redacted, Schedule, Scope, Semaphore } from "effect";
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
import { isSystemKey } from "./platform-runtime.ts";
import type {
  NativeSystemKey,
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

/**
 * How long a passing environment check covers observations. Validation runs
 * on this slow cadence and when the foreground app changes, never once per
 * observation, so observing the user's Forwarded Input stays cheap. Agent
 * actions still validate around every dispatch.
 */
export const OBSERVATION_VALIDATION_MILLIS = 10_000;

/**
 * How long an incomplete capture is taken again before it counts as a Capture
 * Gap. A screen transition, such as a loading screen between two app screens,
 * leaves the accessibility tree briefly without its app window; a capture a
 * moment later is complete. A gap that lasts past this window is real.
 */
export const CAPTURE_SETTLE_WINDOW = "5 seconds";
const CAPTURE_SETTLE_SPACING = "250 millis";

export const adaptNativeAppRuntime = <
  Observation extends PlatformObservation,
  Device,
>(input: {
  readonly startup: NativeAppRuntimeStartInput<Device>;
  readonly backend: NativeAppRuntimeBackend<Observation>;
  readonly capabilities: readonly PlatformCapability[];
  readonly policy: NativeAppActionPolicy<Observation>;
  readonly error?: typeof nativeAppRuntimeError;
  /** The app an observation shows in front, when the platform reports one. */
  readonly foreground?: (observation: Observation) => string | undefined;
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
    let validatedAt: number | undefined;
    let validatedForeground: string | undefined;
    const capture = Effect.gen(function* observeAndroid() {
      yield* invalidate;
      const now = yield* Clock.currentTimeMillis;
      const due =
        validatedAt === undefined ||
        now - validatedAt >= OBSERVATION_VALIDATION_MILLIS;
      if (due) {
        validatedAt = undefined;
        yield* input.backend.validate();
        validatedAt = now;
      }
      const attempt = yield* input.backend.capture().pipe(
        Effect.retry({
          schedule: Schedule.spaced(CAPTURE_SETTLE_SPACING).pipe(
            Schedule.upTo({ duration: CAPTURE_SETTLE_WINDOW })
          ),
          while: (cause) => cause.code === "capture_incomplete",
        }),
        Effect.result
      );
      if (attempt._tag === "Failure") {
        // Android 11 refuses screencap on FLAG_SECURE before post-capture
        // checks run, so verify visibility on capture failure too.
        const visibility = yield* (
          input.backend.requireVisibleScreen?.() ?? Effect.void
        ).pipe(Effect.result);
        return yield* Effect.fail(
          visibility._tag === "Failure" &&
            visibility.failure.code === "secure_window"
            ? visibility.failure
            : attempt.failure
        );
      }
      const captured = attempt.success;
      // A capture of a secure window is not evidence, whatever the cadence.
      yield* input.backend.requireVisibleScreen?.() ?? Effect.void;
      const foreground = input.foreground?.(captured);
      if (!due && foreground !== validatedForeground) {
        // Another app came forward since the last check: check again now.
        validatedAt = undefined;
        yield* input.backend.validate();
        validatedAt = yield* Clock.currentTimeMillis;
      }
      validatedForeground = foreground;
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
      action: PlatformAction | { readonly type: NativeSystemKey }
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
            if (isSystemKey(action)) {
              if (input.backend.systemKey === undefined) {
                return yield* Effect.fail(error("capability_missing"));
              }
              yield* input.backend.systemKey(action.type);
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
              // A recovered device is checked again before it is trusted.
              validatedAt = undefined;
              return yield* capture;
            })
          )
        ),
      rotate: (orientation) =>
        lock.withPermits(1)(
          Effect.gen(function* rotateDevice() {
            if (state().phase === "closed") {
              return yield* Effect.fail(error("runtime_closed"));
            }
            if (input.backend.rotate === undefined) {
              return yield* Effect.fail(error("capability_missing"));
            }
            // The screen turns; no earlier observation still describes it.
            yield* invalidate;
            yield* input.backend.rotate(orientation);
          })
        ),
      screenRecorder: input.backend.screenRecorder,
      state,
      systemKey: (id, key) => mutate(id, { type: key }),
    };
  });
