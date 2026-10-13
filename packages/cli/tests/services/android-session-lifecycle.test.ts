import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { AtomRegistry } from "effect/reactivity";

import { makeAndroidSessionLifecycle } from "../../src/services/android-session-lifecycle.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";

it.effect(
  "retries recovery after closing the SDK session and failing device revalidation",
  () =>
    Effect.gen(function* retryAfterClose() {
      const registry = AtomRegistry.make();
      const commands: string[] = [];
      let serial: string | null = "selected-device";
      let validations = 0;
      let restored = false;
      const lifecycle = makeAndroidSessionLifecycle({
        close: () =>
          Effect.sync(() => {
            commands.push("close");
            serial = null;
          }),
        open: () =>
          Effect.sync(() => {
            commands.push("open");
            serial = "selected-device";
          }),
        readSerial: () => Effect.sync(() => serial),
        registry,
        serial: "selected-device",
        validateEnvironment: () =>
          Effect.suspend(() => {
            validations += 1;
            return validations === 2 && !restored
              ? Effect.fail(platformRuntimeError("device_disconnected"))
              : Effect.void;
          }),
      });
      expect((yield* Effect.flip(lifecycle.recover())).code).toBe(
        "device_disconnected"
      );
      expect(commands).toEqual(["close"]);
      restored = true;
      yield* lifecycle.recover();
      yield* lifecycle.requireSession();
      expect(commands).toEqual(["close", "open"]);
      registry.dispose();
    })
);

it.effect("retries after cancellation in the post-close validation gap", () =>
  Effect.gen(function* cancelAfterClose() {
    const registry = AtomRegistry.make();
    const entered = yield* Deferred.make<boolean>();
    const commands: string[] = [];
    let serial: string | null = "selected-device";
    let validations = 0;
    const lifecycle = makeAndroidSessionLifecycle({
      close: () =>
        Effect.sync(() => {
          commands.push("close");
          serial = null;
        }),
      open: () =>
        Effect.sync(() => {
          commands.push("open");
          serial = "selected-device";
        }),
      readSerial: () => Effect.sync(() => serial),
      registry,
      serial: "selected-device",
      validateEnvironment: () =>
        Effect.suspend(() => {
          validations += 1;
          return validations === 2
            ? Deferred.succeed(entered, true).pipe(Effect.andThen(Effect.never))
            : Effect.void;
        }),
    });
    const recovery = yield* Effect.forkChild(lifecycle.recover());
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(recovery);
    expect((yield* Effect.flip(lifecycle.requireSession())).code).toBe(
      "runtime_paused"
    );
    yield* lifecycle.recover();
    yield* lifecycle.requireSession();
    expect(commands).toEqual(["close", "open"]);
    registry.dispose();
  })
);

it.effect("retries a failed reopen without losing strict device binding", () =>
  Effect.gen(function* retryOpen() {
    const registry = AtomRegistry.make();
    const commands: string[] = [];
    let serial: string | null = "selected-device";
    let failOpen = true;
    const lifecycle = makeAndroidSessionLifecycle({
      close: () =>
        Effect.sync(() => {
          commands.push("close");
          serial = null;
        }),
      open: () =>
        Effect.suspend(() => {
          commands.push("open");
          return failOpen
            ? Effect.fail(platformRuntimeError("runtime_failed"))
            : Effect.sync(() => {
                serial = "selected-device";
              });
        }),
      readSerial: () => Effect.sync(() => serial),
      registry,
      serial: "selected-device",
      validateEnvironment: () => Effect.void,
    });
    yield* Effect.flip(lifecycle.recover());
    serial = "unrelated-device";
    expect((yield* Effect.flip(lifecycle.recover())).code).toBe(
      "device_mismatch"
    );
    expect(commands).toEqual(["close", "open"]);
    serial = null;
    failOpen = false;
    yield* lifecycle.recover();
    yield* lifecycle.requireSession();
    expect(commands).toEqual(["close", "open", "open"]);
    registry.dispose();
  })
);

it.effect(
  "refuses missing sessions outside owned recovery and preserves helper refusal on retry",
  () =>
    Effect.gen(function* refuseUnsafeRecovery() {
      const registry = AtomRegistry.make();
      const commands: string[] = [];
      let serial: string | null = null;
      let validations = 0;
      let helperCompatible = true;
      const lifecycle = makeAndroidSessionLifecycle({
        close: () =>
          Effect.sync(() => {
            commands.push("close");
            serial = null;
          }),
        open: () =>
          Effect.sync(() => {
            commands.push("open");
            serial = "selected-device";
          }),
        readSerial: () => Effect.sync(() => serial),
        registry,
        serial: "selected-device",
        validateEnvironment: () =>
          Effect.suspend(() => {
            validations += 1;
            if (validations === 3) {
              helperCompatible = false;
            }
            return helperCompatible
              ? Effect.void
              : Effect.fail(platformRuntimeError("helper_incompatible"));
          }),
      });
      expect((yield* Effect.flip(lifecycle.requireSession())).code).toBe(
        "device_mismatch"
      );
      expect((yield* Effect.flip(lifecycle.recover())).code).toBe(
        "device_mismatch"
      );
      expect(commands).toEqual([]);
      serial = "selected-device";
      expect((yield* Effect.flip(lifecycle.recover())).code).toBe(
        "helper_incompatible"
      );
      expect((yield* Effect.flip(lifecycle.recover())).code).toBe(
        "helper_incompatible"
      );
      expect(commands).toEqual(["close"]);
      helperCompatible = true;
      yield* lifecycle.recover();
      expect(commands).toEqual(["close", "open"]);
      registry.dispose();
    })
);

it.effect(
  "reconciles an uncertain reopen only within the owned SDK session",
  () =>
    Effect.gen(function* uncertainOpen() {
      const registry = AtomRegistry.make();
      const commands: string[] = [];
      let serial: string | null = "selected-device";
      let firstOpen = true;
      const lifecycle = makeAndroidSessionLifecycle({
        close: () =>
          Effect.sync(() => {
            commands.push("close");
            serial = null;
          }),
        open: () =>
          Effect.suspend(() => {
            commands.push("open");
            serial = "selected-device";
            if (firstOpen) {
              firstOpen = false;
              return Effect.fail(platformRuntimeError("runtime_failed"));
            }
            return Effect.void;
          }),
        readSerial: () => Effect.sync(() => serial),
        registry,
        serial: "selected-device",
        validateEnvironment: () => Effect.void,
      });
      yield* Effect.flip(lifecycle.recover());
      expect((yield* Effect.flip(lifecycle.requireSession())).code).toBe(
        "runtime_paused"
      );
      yield* lifecycle.recover();
      yield* lifecycle.requireSession();
      expect(commands).toEqual(["close", "open", "close", "open"]);
      registry.dispose();
    })
);
