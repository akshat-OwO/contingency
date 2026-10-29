import { expect, it } from "@effect/vitest";
import { AppError } from "agent-device";
import { Effect, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";

import {
  makeIosSessionAccess,
  iosAgentDeviceFailure,
  iosAppStateProblem,
  iosCaptureFailure,
  traceIosCapture,
  iosRuntimeError,
  iosSnapshotFailure,
  iosSnapshotProblem,
  iosWindowViewport,
  observeIosPostAction,
  settleIosCapture,
} from "../../src/services/ios-runtime.ts";
import type { PlatformRuntimeError } from "../../src/services/platform-runtime.ts";

const sequence = (
  results: readonly (PlatformRuntimeError["code"] | "observed")[]
) => {
  let calls = 0;
  const capture = Effect.suspend(() => {
    const result = results[Math.min(calls, results.length - 1)];
    calls += 1;
    return result === "observed"
      ? Effect.succeed(result)
      : Effect.fail(iosRuntimeError(result ?? "capture_incomplete"));
  });
  return { calls: () => calls, capture };
};

it.effect("observes again after a system surface cuts one capture short", () =>
  Effect.gen(function* settlesTransientTruncation() {
    // The pinned SDK returned one truncated tree for AutoFill's sheet after sign-in.
    const source = sequence([
      "observation_stale",
      "observation_stale",
      "observed",
    ]);
    const fiber = yield* Effect.forkChild(settleIosCapture(source.capture));
    // settleIosCapture spaces retries with the TestClock this it.effect provides.
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toBe("observed");
    expect(source.calls()).toBe(3);
  })
);

it.effect("refuses input when every capture stays incomplete", () =>
  Effect.gen(function* refusesPersistentTruncation() {
    const source = sequence(["observation_stale"]);
    const fiber = yield* Effect.forkChild(
      Effect.flip(settleIosCapture(source.capture))
    );
    // The 30-second capture bound runs on this test's TestClock.
    yield* TestClock.adjust("31 seconds");
    const failure = yield* Fiber.join(fiber);
    expect(failure.code).toBe("capture_incomplete");
    expect(failure.operation).toBe("capture");
    expect(failure.message).toContain("settle-deadline");
  })
);

it.effect("does not retry a device or capture failure", () =>
  Effect.gen(function* failsWithoutRetry() {
    const source = sequence(["device_mismatch", "observed"]);
    const failure = yield* Effect.flip(settleIosCapture(source.capture));
    expect(failure.code).toBe("device_mismatch");
    expect(source.calls()).toBe(1);
  })
);

it("observes a truncated system-surface tree again but rejects a missing viewport", () => {
  const viewport = { height: 874, width: 402 };
  expect(
    iosSnapshotProblem({ refsGeneration: 525_348, truncated: true, viewport })
  ).toBe("observation_stale");
  expect(
    iosSnapshotProblem({ refsGeneration: 525_349, truncated: false, viewport })
  ).toBeNull();
  expect(iosSnapshotProblem({ refsGeneration: 1, truncated: false })).toBe(
    "capture_incomplete"
  );
  expect(iosSnapshotProblem({ truncated: false, viewport })).toBe(
    "capture_incomplete"
  );
});

it("keeps the app window viewport while a system alert is presented", () => {
  const window = { height: 874, width: 402 };
  // agent-device 0.21.25 reported the notification alert's frame as the viewport; its rects stay in window points.
  const alert = {
    nodes: [{ rect: { height: 236, width: 320, x: 41, y: 333 } }],
    viewport: { height: 236, width: 320 },
  };
  expect(iosWindowViewport(alert, window)).toEqual(window);
  expect(iosWindowViewport(alert, null)).toEqual(alert.viewport);
  const app = {
    nodes: [{ rect: { height: 874, width: 402, x: 0, y: 0 } }],
    viewport: window,
  };
  expect(iosWindowViewport(app, { height: 402, width: 874 })).toEqual(window);
  const outside = {
    nodes: [{ rect: { height: 236, width: 320, x: 300, y: 333 } }],
    viewport: { height: 236, width: 320 },
  };
  expect(iosWindowViewport(outside, window)).toEqual(outside.viewport);
});

it("names the failed step and agent-device code without its message", () => {
  const failure = iosAgentDeviceFailure(
    new AppError("COMMAND_FAILED", "typed fixture-password into Password", {
      reason: "stale_ref",
    }),
    "runtime_failed",
    "activate"
  );
  expect(failure).toMatchObject({
    backendReason: "stale_ref",
    code: "runtime_failed",
    operation: "activate",
  });
  expect(failure.message).toBe(
    "iOS runtime_failed during activate (COMMAND_FAILED, stale_ref). Inspect this session and explicitly recover before input."
  );
  const unsafe = iosAgentDeviceFailure(
    new AppError("COMMAND_FAILED", "secret", {
      reason: "fixture-password typed",
    }),
    "runtime_failed",
    "screenshot"
  );
  expect(unsafe.message).toBe(
    "iOS runtime_failed during screenshot (COMMAND_FAILED). Inspect this session and explicitly recover before input."
  );
  expect(
    iosAgentDeviceFailure(new Error("secret"), "runtime_failed", "capture")
      .message
  ).toBe(
    "iOS runtime_failed during capture. Inspect this session and explicitly recover before input."
  );
});

it.effect("observes again when one snapshot arrives without a viewport", () =>
  Effect.gen(function* settlesMissingViewport() {
    // agent-device 0.21.25 refused one Run capture after sign-in with invalid-viewport.
    let calls = 0;
    const capture = Effect.tryPromise({
      catch: iosSnapshotFailure,
      try: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(
              new AppError("COMMAND_FAILED", "viewport", {
                field: "viewport",
                reason: "invalid-viewport",
              })
            )
          : Promise.resolve("observed");
      },
    });
    const fiber = yield* Effect.forkChild(settleIosCapture(capture));
    // settleIosCapture spaces retries with the TestClock this it.effect provides.
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toBe("observed");
    expect(calls).toBe(2);
    expect(
      iosSnapshotFailure(
        new AppError("COMMAND_FAILED", "viewport", {
          reason: "missing-viewport",
        })
      ).code
    ).toBe("observation_stale");
    expect(
      iosSnapshotFailure(
        new AppError("COMMAND_FAILED", "gone", { reason: "device_not_found" })
      ).code
    ).toBe("runtime_failed");
  })
);

it.effect(
  "never activates the Target App while observing a foreign foreground",
  () =>
    Effect.gen(function* foreignForeground() {
      const calls: unknown[] = [];
      const access = makeIosSessionAccess({
        open: () => {
          throw new Error("Observation must never open an app");
        },
        options: () => ({
          platform: "ios",
          requestId: "capture",
          udid: "session-simulator",
        }),
        snapshot: (options) => {
          calls.push(options);
          return Promise.reject(
            new AppError(
              "OBSERVATION_UNAVAILABLE",
              "session app is backgrounded"
            )
          );
        },
        targetApp: "dev.fixture",
      });
      const failure = yield* Effect.flip(access.snapshot());
      expect(calls).toEqual([
        expect.objectContaining({
          noRecord: true,
          observeOnly: true,
          udid: "session-simulator",
        }),
      ]);
      expect(failure.code).toBe("foreign_app_foreground");
    })
);

it("maps observe-only refusal to a distinct typed reason", () => {
  expect(
    iosSnapshotFailure(new AppError("OBSERVATION_UNAVAILABLE", "background"))
  ).toMatchObject({ code: "foreign_app_foreground", operation: "capture" });
});

it.effect("returns to the session bundle without relaunching", () =>
  Effect.gen(function* returnToTargetApp() {
    const calls: unknown[] = [];
    const access = makeIosSessionAccess({
      open: (options) => {
        calls.push(options);
        return Promise.resolve({});
      },
      options: () => ({
        platform: "ios",
        requestId: "recover",
        udid: "session-simulator",
      }),
      snapshot: () => Promise.resolve("observed"),
      targetApp: "dev.fixture",
    });
    yield* access.recover();
    expect(calls).toEqual([
      expect.objectContaining({
        app: "dev.fixture",
        platform: "ios",
        relaunch: false,
        udid: "session-simulator",
      }),
    ]);
    expect(yield* access.snapshot()).toBe("observed");
  })
);

it.effect("does not retry or activate after an observe-only refusal", () =>
  Effect.gen(function* refusesWithoutActivation() {
    let snapshots = 0;
    let opens = 0;
    const access = makeIosSessionAccess({
      open: () => {
        opens += 1;
        return Promise.resolve({});
      },
      options: () => ({
        platform: "ios",
        requestId: "capture",
        udid: "same-simulator",
      }),
      snapshot: () => {
        snapshots += 1;
        return Promise.reject(
          new AppError("OBSERVATION_UNAVAILABLE", "background")
        );
      },
      targetApp: "dev.fixture",
    });
    expect((yield* Effect.flip(settleIosCapture(access.snapshot()))).code).toBe(
      "foreign_app_foreground"
    );
    expect(snapshots).toBe(1);
    expect(opens).toBe(0);
  })
);

it("refuses a Target App that backgrounds between its tree and screenshot", () => {
  const foreground = {
    appBundleId: "dev.fixture",
    appName: "Fixture",
    device_udid: "session-simulator",
    platform: "ios",
    source: "runner",
    state: "runningForeground",
    surface: "app",
  } as const;
  expect(
    iosAppStateProblem(foreground, "session-simulator", "dev.fixture")
  ).toBeNull();
  expect(
    iosAppStateProblem(
      { ...foreground, state: "runningBackground" },
      "session-simulator",
      "dev.fixture"
    )
  ).toBe("foreign_app_foreground");
  expect(
    iosAppStateProblem(
      { ...foreground, state: "runningBackgroundSuspended" },
      "session-simulator",
      "dev.fixture"
    )
  ).toBe("foreign_app_foreground");
  expect(
    iosAppStateProblem(
      { ...foreground, source: "session" },
      "session-simulator",
      "dev.fixture"
    )
  ).toBe("observation_stale");
  expect(iosAppStateProblem(foreground, "other-simulator", "dev.fixture")).toBe(
    "device_mismatch"
  );
  expect(
    iosAppStateProblem(foreground, "session-simulator", "other.bundle")
  ).toBe("target_changed");
});

const screen = (
  generation: number,
  names = ["Open account", "Open device settings"]
) => ({
  generation,
  nodes: names.map((name) => ({
    name,
    role: "button",
    target: `${generation}-${name}`,
  })),
});

it.effect("accepts a changed post-action screen with one capture", () =>
  Effect.gen(function* acceptsChangedScreen() {
    let calls = 0;
    const capture = Effect.sync(() => {
      calls += 1;
      return screen(calls, ["Account details"]);
    });
    expect(yield* observeIosPostAction(capture, screen(0))).toEqual(
      screen(1, ["Account details"])
    );
    expect(calls).toBe(1);
  })
);

it.effect(
  "re-observes an unchanged screen within the three-capture bound",
  () =>
    Effect.gen(function* boundsUnchangedScreen() {
      let calls = 0;
      const capture = Effect.sync(() => {
        calls += 1;
        return screen(calls);
      });
      expect(yield* observeIosPostAction(capture, screen(0))).toEqual(
        screen(3)
      );
      expect(calls).toBe(3);
    })
);

it.effect("withholds unchanged handoff trees until the refusal", () =>
  Effect.gen(function* refusesHandoffTree() {
    let calls = 0;
    const capture = Effect.suspend(() => {
      calls += 1;
      return calls < 3
        ? Effect.succeed(screen(calls))
        : Effect.fail(iosRuntimeError("foreign_app_foreground"));
    });
    const failure = yield* Effect.flip(
      observeIosPostAction(capture, screen(0))
    );
    expect(failure.code).toBe("foreign_app_foreground");
    expect(calls).toBe(3);
  })
);

it.effect("withholds a stale handoff tree that loses a redundant label", () =>
  Effect.gen(function* refusesPartialHandoffTree() {
    const before = {
      nodes: [
        ...screen(0).nodes,
        { name: "Open account", role: "text", target: "label" },
      ],
    };
    let calls = 0;
    const capture = Effect.suspend(() => {
      calls += 1;
      return calls < 3
        ? Effect.succeed(screen(calls))
        : Effect.fail(iosRuntimeError("foreign_app_foreground"));
    });
    const failure = yield* Effect.flip(observeIosPostAction(capture, before));
    expect(failure.code).toBe("foreign_app_foreground");
    expect(calls).toBe(3);
  })
);

it.effect("does not capture again after the first post-action refusal", () =>
  Effect.gen(function* preservesInitialRefusal() {
    const source = sequence(["foreign_app_foreground", "observed"]);
    const capture = source.capture.pipe(Effect.as(screen(1)));
    const failure = yield* Effect.flip(
      observeIosPostAction(capture, screen(0))
    );
    expect(failure.code).toBe("foreign_app_foreground");
    expect(source.calls()).toBe(1);
  })
);

it.effect(
  "records failed capture steps without snapshot content or SDK messages",
  () =>
    Effect.gen(function* recordsCaptureFailure() {
      const messages: unknown[] = [];
      const logger = Logger.make((event) => {
        messages.push(event.message);
      });
      const failure = iosAgentDeviceFailure(
        new AppError("COMMAND_FAILED", "secret screenshot contents", {
          reason: "invalid-viewport",
        }),
        "runtime_failed",
        "screenshot"
      );
      const result = yield* Effect.flip(
        traceIosCapture(
          (step) =>
            Effect.gen(function* capture() {
              yield* step(
                "snapshot",
                Effect.succeed({ nodes: ["private field value"] })
              );
              return yield* step("screenshot", Effect.fail(failure));
            }),
          7
        )
      ).pipe(Effect.provide(Logger.layer([logger])));
      expect(result).toEqual(failure);
      // it.effect supplies virtual monotonic time; no host duration is asserted.
      expect(messages).toEqual([
        [
          "iOS capture failed",
          {
            attempt: 7,
            code: "runtime_failed",
            detail: failure.message,
            durationMs: 0,
            operation: "screenshot",
            steps: [
              { durationMs: 0, outcome: "ok", step: "snapshot" },
              { durationMs: 0, outcome: "failed", step: "screenshot" },
            ],
          },
        ],
      ]);
    })
);

it("distinguishes local capture failures from SDK failures", () => {
  for (const reason of [
    "snapshot-metadata",
    "app-state-unverified",
    "png-header",
    "settle-deadline",
  ] as const) {
    const failure = iosCaptureFailure("capture_incomplete", "capture", reason);
    expect(failure).toMatchObject({
      code: "capture_incomplete",
      operation: "capture",
    });
    expect(failure.message).toContain(`during capture (${reason})`);
  }
});

it.effect(
  "re-observes a passive app-state read until the runner verifies foreground",
  () =>
    Effect.gen(function* settlesPassiveState() {
      let calls = 0;
      const capture = Effect.suspend(() => {
        calls += 1;
        const state = {
          appBundleId: "dev.fixture",
          appName: "Fixture",
          device_udid: "selected",
          platform: "ios" as const,
          surface: "app" as const,
          ...(calls === 1
            ? { source: "session" as const }
            : {
                source: "runner" as const,
                state: "runningForeground" as const,
              }),
        };
        const problem = iosAppStateProblem(state, "selected", "dev.fixture");
        return problem === null
          ? Effect.succeed("verified")
          : Effect.fail(iosRuntimeError(problem));
      });
      const fiber = yield* Effect.forkChild(
        Effect.result(settleIosCapture(capture))
      );
      // The existing capture retry schedule receives it.effect's TestClock.
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "Success",
        success: "verified",
      });
      expect(calls).toBe(2);
    })
);

it.effect(
  "refuses a persistently unverified app state within the existing capture bound",
  () =>
    Effect.gen(function* refusesPassiveState() {
      const problem = iosAppStateProblem(
        {
          appBundleId: "dev.fixture",
          appName: "Fixture",
          device_udid: "selected",
          platform: "ios",
          source: "session",
          surface: "app",
        },
        "selected",
        "dev.fixture"
      );
      expect(problem).toBe("observation_stale");
      const source = sequence([problem ?? "observed"]);
      const fiber = yield* Effect.forkChild(
        Effect.flip(settleIosCapture(source.capture))
      );
      // The capture deadline and retry spacing both receive this test's TestClock.
      yield* TestClock.adjust("31 seconds");
      expect((yield* Fiber.join(fiber)).code).toBe("capture_incomplete");
    })
);

it("withholds runner results without state and session results claiming foreground", () => {
  const state = {
    appBundleId: "dev.fixture",
    appName: "Fixture",
    device_udid: "selected",
    platform: "ios",
    surface: "app",
  } as const;
  expect(
    iosAppStateProblem(
      { ...state, source: "runner" },
      "selected",
      "dev.fixture"
    )
  ).toBe("observation_stale");
  expect(
    iosAppStateProblem(
      { ...state, source: "session", state: "runningForeground" },
      "selected",
      "dev.fixture"
    )
  ).toBe("observation_stale");
});
