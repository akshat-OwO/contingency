import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { AtomRegistry } from "effect/reactivity";

import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

/** The private SDK session may be absent only while retrying owned recovery. */
export const makeAndroidSessionLifecycle = (input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly serial: string;
  readonly readSerial: () => Effect.Effect<string | null, PlatformRuntimeError>;
  readonly validateEnvironment: () => Effect.Effect<void, PlatformRuntimeError>;
  readonly close: () => Effect.Effect<void, PlatformRuntimeError>;
  readonly open: () => Effect.Effect<void, PlatformRuntimeError>;
}) => {
  const reopening = Atom.make(false).pipe(Atom.keepAlive);
  input.registry.get(reopening);
  const requireSession = () =>
    Effect.gen(function* requireOwnedSession() {
      if (input.registry.get(reopening)) {
        return yield* Effect.fail(platformRuntimeError("runtime_paused"));
      }
      if ((yield* input.readSerial()) !== input.serial) {
        return yield* Effect.fail(platformRuntimeError("device_mismatch"));
      }
    });
  return {
    recover: () =>
      Effect.gen(function* recoverOwnedSession() {
        yield* input.validateEnvironment();
        const selected = yield* input.readSerial();
        if (selected !== null && selected !== input.serial) {
          return yield* Effect.fail(platformRuntimeError("device_mismatch"));
        }
        if (selected === null && !input.registry.get(reopening)) {
          return yield* Effect.fail(platformRuntimeError("device_mismatch"));
        }
        // Mark before close: cancellation cannot prove whether the SDK closed it.
        input.registry.set(reopening, true);
        if (selected !== null) {
          yield* input.close();
        }
        yield* input.validateEnvironment();
        yield* input.open();
        if ((yield* input.readSerial()) !== input.serial) {
          return yield* Effect.fail(platformRuntimeError("device_mismatch"));
        }
        input.registry.set(reopening, false);
      }),
    requireSession,
  };
};
