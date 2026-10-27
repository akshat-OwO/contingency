import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { nativeAppRuntimeError } from "./native-app-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

/** The private SDK session may be absent only while retrying owned recovery. */
export const makeNativeAppSessionLifecycle = (input: {
  readonly error?: typeof nativeAppRuntimeError;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly deviceId: string;
  readonly readDeviceId: () => Effect.Effect<
    string | null,
    PlatformRuntimeError
  >;
  readonly validateEnvironment: () => Effect.Effect<void, PlatformRuntimeError>;
  readonly close: () => Effect.Effect<void, PlatformRuntimeError>;
  readonly open: () => Effect.Effect<void, PlatformRuntimeError>;
}) => {
  const error = input.error ?? nativeAppRuntimeError;
  const reopening = Atom.make(false).pipe(Atom.keepAlive);
  input.registry.get(reopening);
  const requireSession = () =>
    Effect.gen(function* requireOwnedSession() {
      if (input.registry.get(reopening)) {
        return yield* Effect.fail(error("runtime_paused"));
      }
      if ((yield* input.readDeviceId()) !== input.deviceId) {
        return yield* Effect.fail(error("device_mismatch"));
      }
    });
  return {
    recover: () =>
      Effect.gen(function* recoverOwnedSession() {
        yield* input.validateEnvironment();
        const selected = yield* input.readDeviceId();
        if (selected !== null && selected !== input.deviceId) {
          return yield* Effect.fail(error("device_mismatch"));
        }
        if (selected === null && !input.registry.get(reopening)) {
          return yield* Effect.fail(error("device_mismatch"));
        }
        // Mark before close: cancellation cannot prove whether the SDK closed it.
        input.registry.set(reopening, true);
        if (selected !== null) {
          yield* input.close();
        }
        yield* input.validateEnvironment();
        yield* input.open();
        if ((yield* input.readDeviceId()) !== input.deviceId) {
          return yield* Effect.fail(error("device_mismatch"));
        }
        input.registry.set(reopening, false);
      }),
    requireSession,
  };
};
