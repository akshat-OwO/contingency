import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  iosRuntimeError,
  iosSnapshotProblem,
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
