import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { makeIosForegroundAuthority } from "../../src/services/ios-foreground.ts";
import { adaptNativeAppRuntime } from "../../src/services/native-app-runtime.ts";

const udid = "37C7B399-B67E-4A27-9A46-61EE16FA6F44";
const target = "dev.contingency.ioslogin";
const response = (bundleId: string, device = udid, pid = 42) =>
  JSON.stringify({ owner: { bundleId, pid }, udid: device, version: 1 });

it.effect("queries the exact bound Simulator on every validation", () =>
  Effect.gen(function* validateTarget() {
    const queries: string[] = [];
    const authority = makeIosForegroundAuthority("unused", (device) =>
      Effect.sync(() => {
        queries.push(device);
        return response(target);
      })
    );
    yield* authority.validate(udid, target);
    yield* authority.validate(udid, target);
    expect(queries).toEqual([udid, udid]);
  })
);

for (const [name, text] of [
  ["Settings", response("com.apple.Preferences")],
  ["Safari", response("com.apple.mobilesafari")],
  ["system UI", response("com.apple.springboard")],
  ["another Simulator", response(target, "other-device")],
  ["unknown PID", response(target, udid, 0)],
  ["fractional PID", response(target, udid, 1.5)],
  ["unknown bundle", response("")],
  ["missing owner", JSON.stringify({ udid, version: 1 })],
  ["malformed output", "not json"],
  [
    "unsupported protocol",
    response(target).replace('"version":1', '"version":2'),
  ],
] as const) {
  it.effect(`fails closed for ${name}`, () =>
    Effect.gen(function* refuseOwner() {
      const authority = makeIosForegroundAuthority("unused", () =>
        Effect.succeed(text)
      );
      expect(
        yield* Effect.flip(authority.validate(udid, target))
      ).toMatchObject({
        _tag: "PlatformRuntimeError",
        code: "ownership_unknown",
      });
    })
  );
}

it.effect("maps helper failure to ownership_unknown", () =>
  Effect.gen(function* helperFailure() {
    const authority = makeIosForegroundAuthority("unused", () =>
      Effect.fail(new Error("unavailable"))
    );
    expect(yield* Effect.flip(authority.validate(udid, target))).toMatchObject({
      code: "ownership_unknown",
    });
  })
);

it.effect(
  "pauses before capture with Settings in front and recovers on the same device",
  () =>
    Effect.gen(function* settingsRegression() {
      let owner = target;
      let captures = 0;
      let inputs = 0;
      const authority = makeIosForegroundAuthority("unused", () =>
        Effect.sync(() => response(owner))
      );
      const validate = () => authority.validate(udid, target);
      const runtime = yield* adaptNativeAppRuntime({
        backend: {
          activate: () =>
            Effect.sync(() => {
              inputs += 1;
            }),
          capture: () =>
            Effect.sync(() => {
              captures += 1;
              return {
                id: `observation-${captures}`,
                nodes: [],
                platform: "ios" as const,
                screenshot: {
                  capturedAt: "2026-10-28T00:00:00Z",
                  encoding: "base64" as const,
                  format: "png" as const,
                  image: "aW1hZ2U=",
                },
              };
            }),
          close: () => Effect.void,
          fill: () => Effect.void,
          recover: validate,
          sessionId: "bound-ios-session",
          validate,
        },
        capabilities: [],
        policy: {
          privateTarget: () => Effect.void,
          publicAction: () => Effect.void,
        },
        startup: {
          device: udid,
          platform: "ios",
          requiredCapabilities: [],
          scope: yield* Effect.scope,
          targetApp: target,
        },
      });
      yield* runtime.observe();
      owner = "com.apple.Preferences";
      expect(yield* Effect.flip(runtime.observe())).toMatchObject({
        code: "ownership_unknown",
      });
      expect(runtime.state()).toMatchObject({
        observationId: null,
        phase: "paused",
      });
      expect(captures).toBe(1);
      owner = target;
      const recovered = yield* runtime.recover();
      expect(runtime.state().phase).toBe("ready");
      expect(runtime.device).toBe(udid);
      expect(captures).toBe(2);
      owner = "com.apple.Preferences";
      expect(
        yield* Effect.flip(
          runtime.dispatch(recovered.id, { target: "button", type: "activate" })
        )
      ).toMatchObject({ code: "ownership_unknown" });
      expect(inputs).toBe(0);
      expect(runtime.state()).toMatchObject({
        observationId: null,
        phase: "paused",
      });
      yield* runtime.close();
    })
);

it.effect("fails closed when the helper never answers", () =>
  Effect.gen(function* stalledHelper() {
    const started = yield* Deferred.make<boolean>();
    const authority = makeIosForegroundAuthority("unused", () =>
      Deferred.succeed(started, true).pipe(Effect.andThen(Effect.never))
    );
    const waiting = yield* authority
      .validate(udid, target)
      .pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(waiting)).toMatchObject({
      code: "ownership_unknown",
    });
  })
);
