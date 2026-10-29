import { expect, it } from "@effect/vitest";
import { AppError } from "agent-device";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  iosAgentDeviceFailure,
  iosRuntimeError,
  iosSnapshotFailure,
  iosSnapshotProblem,
  iosWindowViewport,
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
    expect((yield* Fiber.join(fiber)).code).toBe("capture_incomplete");
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
