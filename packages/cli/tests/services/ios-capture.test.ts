import { expect, it } from "@effect/vitest";
import { AppError } from "agent-device";
import { Effect, Fiber, Logger, Option, Result } from "effect";
import { TestClock } from "effect/testing";

import { SPRINGBOARD } from "../../src/services/ios-foreground.ts";
import {
  IOS_FOREGROUND_HANDOFF_UNAVAILABLE_HINT,
  IOS_HANDOFF_READINGS,
  IOS_SYSTEM_ALERT_UNAVAILABLE_HINT,
  canSkipIosAlertScreenshot,
  canSkipIosScreenshot,
  followIosHandoff,
  iosAlertActivateFailure,
  iosAlertNodes,
  isIosForegroundHandoffObservationUnavailable,
  isIosSystemAlertObservationUnavailable,
  makeIosSessionAccess,
  iosAgentDeviceFailure,
  iosAppStateProblem,
  iosCaptureFailure,
  iosForegroundUnknown,
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
    // The runner refuses a read while an app comes forward (#740 proof).
    expect(
      iosSnapshotFailure(
        new AppError("COMMAND_FAILED", "busy", {
          dispatched: "no",
          reason: "runner_busy",
          retriable: true,
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
  "reads no tree, and never activates an app, while another app is in front",
  () =>
    Effect.gen(function* backgroundedApp() {
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
      });
      expect(Option.isNone(yield* access.snapshot())).toBe(true);
      expect(calls).toEqual([
        expect.objectContaining({
          noRecord: true,
          observeOnly: true,
          udid: "session-simulator",
        }),
      ]);
    })
);

it("identifies OBSERVATION_UNAVAILABLE carrying agent-device's system-alert hint", () => {
  expect(
    isIosSystemAlertObservationUnavailable(
      new AppError(
        "OBSERVATION_UNAVAILABLE",
        "The session app cannot be observed without activation.",
        {
          dispatched: "no",
          hint: IOS_SYSTEM_ALERT_UNAVAILABLE_HINT,
          runner: {
            error: {
              code: "OBSERVATION_UNAVAILABLE",
              hint: IOS_SYSTEM_ALERT_UNAVAILABLE_HINT,
              message: "The session app cannot be observed without activation.",
            },
            ok: false,
          },
          runnerErrorCode: "OBSERVATION_UNAVAILABLE",
        }
      )
    )
  ).toBe(true);
  // Nested runner.error.hint alone still classifies as a system alert.
  expect(
    isIosSystemAlertObservationUnavailable(
      new AppError(
        "OBSERVATION_UNAVAILABLE",
        "The session app cannot be observed without activation.",
        {
          runner: {
            error: {
              code: "OBSERVATION_UNAVAILABLE",
              hint: IOS_SYSTEM_ALERT_UNAVAILABLE_HINT,
            },
          },
        }
      )
    )
  ).toBe(true);
  // Default backgrounded hint and non-alert codes do not match.
  expect(
    isIosSystemAlertObservationUnavailable(
      new AppError(
        "OBSERVATION_UNAVAILABLE",
        "The session app cannot be observed without activation.",
        {
          hint: "XCUIApplication must report runningForeground before and after capture. This state report does not prove screen ownership (#2696).",
        }
      )
    )
  ).toBe(false);
  expect(
    isIosSystemAlertObservationUnavailable(
      new AppError("OBSERVATION_UNAVAILABLE", "session app is backgrounded")
    )
  ).toBe(false);
  expect(
    isIosSystemAlertObservationUnavailable(
      new AppError("COMMAND_FAILED", "other failure", {
        hint: IOS_SYSTEM_ALERT_UNAVAILABLE_HINT,
      })
    )
  ).toBe(false);
  expect(isIosSystemAlertObservationUnavailable(new Error("plain"))).toBe(
    false
  );
});

it("identifies OBSERVATION_UNAVAILABLE carrying the foreground-handoff hint", () => {
  expect(
    isIosForegroundHandoffObservationUnavailable(
      new AppError(
        "OBSERVATION_UNAVAILABLE",
        "The session app cannot be observed without activation.",
        {
          hint: IOS_FOREGROUND_HANDOFF_UNAVAILABLE_HINT,
        }
      )
    )
  ).toBe(true);
  expect(
    isIosForegroundHandoffObservationUnavailable(
      new AppError(
        "OBSERVATION_UNAVAILABLE",
        "The session app cannot be observed without activation.",
        {
          runner: {
            error: {
              code: "OBSERVATION_UNAVAILABLE",
              hint: IOS_FOREGROUND_HANDOFF_UNAVAILABLE_HINT,
            },
          },
        }
      )
    )
  ).toBe(true);
  expect(
    isIosForegroundHandoffObservationUnavailable(
      new AppError(
        "OBSERVATION_UNAVAILABLE",
        "The session app cannot be observed without activation.",
        { hint: IOS_SYSTEM_ALERT_UNAVAILABLE_HINT }
      )
    )
  ).toBe(false);
  expect(
    isIosForegroundHandoffObservationUnavailable(
      new AppError(
        "OBSERVATION_UNAVAILABLE",
        "The session app cannot be observed without activation.",
        {
          hint: "XCUIApplication must report runningForeground before and after capture. This state report does not prove screen ownership (#2696).",
        }
      )
    )
  ).toBe(false);
  expect(
    isIosForegroundHandoffObservationUnavailable(
      new AppError("COMMAND_FAILED", "other", {
        hint: IOS_FOREGROUND_HANDOFF_UNAVAILABLE_HINT,
      })
    )
  ).toBe(false);
});

it.effect(
  "reads a foreground-handoff OBSERVATION_UNAVAILABLE as a handoff without consulting appState or alert get",
  () =>
    Effect.gen(function* fastForegroundHandoff() {
      let appStateCalls = 0;
      let alertCalls = 0;
      const access = makeIosSessionAccess({
        alert: () => {
          alertCalls += 1;
          return Promise.resolve({ items: ["Allow"], message: "Alert" });
        },
        appState: () => {
          appStateCalls += 1;
          return Promise.resolve({
            appBundleId: "dev.contingency.ioslogin",
            appName: "dev.contingency.ioslogin",
            device_udid: "session-simulator",
            platform: "ios" as const,
            source: "runner" as const,
            state: "runningForeground" as const,
            surface: "app" as const,
          });
        },
        open: () => {
          throw new Error("Foreground handoff must never activate an app");
        },
        options: () => ({
          platform: "ios",
          requestId: "capture",
          udid: "session-simulator",
        }),
        snapshot: () =>
          Promise.reject(
            new AppError(
              "OBSERVATION_UNAVAILABLE",
              "The session app cannot be observed without activation.",
              {
                hint: IOS_FOREGROUND_HANDOFF_UNAVAILABLE_HINT,
              }
            )
          ),
      });
      expect(yield* access.snapshot("dev.contingency.ioslogin")).toStrictEqual(
        Option.some({ _tag: "handoff" })
      );
      expect(appStateCalls).toBe(0);
      expect(alertCalls).toBe(0);
    })
);

it.effect(
  "reads a presented system alert via non-activating alert get when observeOnly rejects with the system-alert hint and appState confirms the bound app is runningForeground",
  () =>
    Effect.gen(function* systemAlertOverBoundApp() {
      const snapshotCalls: unknown[] = [];
      const alertCalls: unknown[] = [];
      let appStateCalls = 0;
      const access = makeIosSessionAccess({
        alert: (options) => {
          alertCalls.push(options);
          return Promise.resolve({
            items: ["Don’t Allow", "Allow"],
            message:
              "“Contingency Public Login” Would Like to Send You Notifications",
          });
        },
        appState: () => {
          appStateCalls += 1;
          return Promise.resolve({
            appBundleId: "dev.contingency.ioslogin",
            appName: "dev.contingency.ioslogin",
            device_udid: "session-simulator",
            platform: "ios" as const,
            source: "runner" as const,
            state: "runningForeground" as const,
            surface: "app" as const,
          });
        },
        open: () => {
          throw new Error("Reading a system alert must never call open");
        },
        options: () => ({
          platform: "ios",
          requestId: "capture",
          udid: "session-simulator",
        }),
        snapshot: (options) => {
          snapshotCalls.push(options);
          return Promise.reject(
            new AppError(
              "OBSERVATION_UNAVAILABLE",
              "The session app cannot be observed without activation.",
              {
                dispatched: "no",
                hint: IOS_SYSTEM_ALERT_UNAVAILABLE_HINT,
                runner: {
                  error: {
                    code: "OBSERVATION_UNAVAILABLE",
                    hint: IOS_SYSTEM_ALERT_UNAVAILABLE_HINT,
                    message:
                      "The session app cannot be observed without activation.",
                  },
                  ok: false,
                },
                runnerErrorCode: "OBSERVATION_UNAVAILABLE",
              }
            )
          );
        },
      });
      expect(yield* access.snapshot("dev.contingency.ioslogin")).toEqual(
        Option.some({
          _tag: "alert",
          alert: {
            identifiers: undefined,
            items: ["Don’t Allow", "Allow"],
            message:
              "“Contingency Public Login” Would Like to Send You Notifications",
          },
        })
      );
      expect(appStateCalls).toBe(1);
      // Never invokes a non-observeOnly snapshot that could call target.activate().
      expect(snapshotCalls).toEqual([
        expect.objectContaining({
          interactiveOnly: false,
          noRecord: true,
          observeOnly: true,
          udid: "session-simulator",
        }),
      ]);
      expect(alertCalls).toEqual([
        expect.objectContaining({
          action: "get",
          platform: "ios",
          udid: "session-simulator",
        }),
      ]);
    })
);

it.effect(
  "returns none without calling alert get or a regular snapshot on genuine cross-app backgrounding",
  () =>
    Effect.gen(function* genuineCrossAppBackgrounding() {
      const snapshotCalls: unknown[] = [];
      let alertCalls = 0;
      let appStateCalls = 0;
      const access = makeIosSessionAccess({
        alert: () => {
          alertCalls += 1;
          return Promise.resolve({ items: ["Allow"], message: "Alert" });
        },
        appState: () => {
          appStateCalls += 1;
          return Promise.resolve({
            appBundleId: "dev.contingency.ioslogin",
            appName: "dev.contingency.ioslogin",
            device_udid: "session-simulator",
            platform: "ios" as const,
            source: "runner" as const,
            state: "runningBackground" as const,
            surface: "app" as const,
          });
        },
        open: () => {
          throw new Error("Backgrounded observation must never call open");
        },
        options: () => ({
          platform: "ios",
          requestId: "capture",
          udid: "session-simulator",
        }),
        snapshot: (options) => {
          snapshotCalls.push(options);
          return Promise.reject(
            new AppError(
              "OBSERVATION_UNAVAILABLE",
              "The session app cannot be observed without activation.",
              {
                hint: "XCUIApplication must report runningForeground before and after capture. This state report does not prove screen ownership (#2696).",
              }
            )
          );
        },
      });
      expect(
        Option.isNone(yield* access.snapshot("dev.contingency.ioslogin"))
      ).toBe(true);
      expect(appStateCalls).toBe(1);
      expect(alertCalls).toBe(0);
      expect(snapshotCalls).toEqual([
        expect.objectContaining({
          noRecord: true,
          observeOnly: true,
          udid: "session-simulator",
        }),
      ]);
    })
);

const handoff = (input: {
  readonly leavesAfter: number | null;
  readonly guess: string | null;
  readonly guessNow: string | null;
  readonly repeated: boolean;
}) => {
  let readings = 0;
  return followIosHandoff({
    guess: Effect.succeed(input.guess),
    guessNow: Effect.succeed(input.guessNow),
    inFront: Effect.sync(() => {
      readings += 1;
      return input.leavesAfter === null || readings <= input.leavesAfter;
    }),
    repeated: input.repeated,
  }).pipe(
    Effect.result,
    Effect.map((result) => ({ readings, result }))
  );
};

it.effect(
  "follows the guessed app once a handing-off app leaves the front",
  () =>
    Effect.gen(function* followsAfterLeaving() {
      const fiber = yield* Effect.forkChild(
        handoff({
          guess: "com.apple.Preferences",
          guessNow: null,
          leavesAfter: 3,
          repeated: false,
        })
      );
      yield* TestClock.adjust("1 second");
      const { readings, result } = yield* Fiber.join(fiber);
      expect(readings).toBe(4);
      expect(result).toStrictEqual(
        Result.succeed({ _tag: "follow", app: "com.apple.Preferences" })
      );
    })
);

it.effect(
  "reports no app when a handing-off app leaves the front and nothing is clearly in front",
  () =>
    Effect.gen(function* noGuessAfterLeaving() {
      const { result } = yield* handoff({
        guess: null,
        guessNow: "com.apple.Preferences",
        leavesAfter: 0,
        repeated: false,
      });
      expect(result).toStrictEqual(Result.succeed(null));
    })
);

it.effect(
  "reads the bound app again when it stays in front, as while an alert is dismissed, without following any app",
  () =>
    Effect.gen(function* rereadsAfterAlert() {
      const fiber = yield* Effect.forkChild(
        handoff({
          guess: "com.apple.Preferences",
          guessNow: "com.apple.Preferences",
          leavesAfter: null,
          repeated: false,
        })
      );
      yield* TestClock.adjust("10 seconds");
      const { readings, result } = yield* Fiber.join(fiber);
      expect(readings).toBe(IOS_HANDOFF_READINGS);
      expect(result).toStrictEqual(
        Result.fail(
          iosCaptureFailure(
            "observation_stale",
            "capture",
            "foreground-handoff"
          )
        )
      );
    })
);

it.effect(
  "follows Springboard when a handoff outlasts its readings twice and no other app is in front, as in the App Switcher",
  () =>
    Effect.gen(function* followsSpringboard() {
      const fiber = yield* Effect.forkChild(
        handoff({
          guess: null,
          guessNow: null,
          leavesAfter: null,
          repeated: true,
        })
      );
      yield* TestClock.adjust("10 seconds");
      const { result } = yield* Fiber.join(fiber);
      expect(result).toStrictEqual(
        Result.succeed({ _tag: "follow", app: SPRINGBOARD })
      );
    })
);

const systemAlertUnavailableError = () =>
  new AppError(
    "OBSERVATION_UNAVAILABLE",
    "The session app cannot be observed without activation.",
    { hint: IOS_SYSTEM_ALERT_UNAVAILABLE_HINT }
  );

it.effect(
  "preserves a new foreground app without activating the bound app when backgrounding happens after appState and before alert get",
  () =>
    Effect.gen(function* backgroundedBetweenAppStateAndAlertRead() {
      const snapshotCalls: unknown[] = [];
      let alertCalls = 0;
      let appStateCalls = 0;
      let boundAppBackgrounded = false;
      const access = makeIosSessionAccess({
        alert: () => {
          alertCalls += 1;
          // Between appState and alert get, the alert disappeared and another
          // app took the foreground; non-activating alert get reports absent
          // without ever activating the bound app.
          boundAppBackgrounded = true;
          return Promise.reject(
            new AppError("COMMAND_FAILED", "alert not found", {
              reason: "alert-not-found",
              runnerErrorCode: "ALERT_NOT_FOUND",
            })
          );
        },
        appState: () => {
          appStateCalls += 1;
          return Promise.resolve({
            appBundleId: "dev.contingency.ioslogin",
            appName: "dev.contingency.ioslogin",
            device_udid: "session-simulator",
            platform: "ios" as const,
            source: "runner" as const,
            state: boundAppBackgrounded
              ? ("runningBackground" as const)
              : ("runningForeground" as const),
            surface: "app" as const,
          });
        },
        open: () => {
          throw new Error("Must never activate or open the bound app");
        },
        options: () => ({
          platform: "ios",
          requestId: "capture",
          udid: "session-simulator",
        }),
        snapshot: (options) => {
          snapshotCalls.push(options);
          if (options.observeOnly !== true) {
            throw new Error(
              "Must never issue a regular snapshot that can call target.activate()"
            );
          }
          return Promise.reject(
            boundAppBackgrounded
              ? new AppError(
                  "OBSERVATION_UNAVAILABLE",
                  "The session app cannot be observed without activation.",
                  {
                    hint: "XCUIApplication must report runningForeground before and after capture. This state report does not prove screen ownership (#2696).",
                  }
                )
              : systemAlertUnavailableError()
          );
        },
      });
      // Attempt 1 sees ALERT_NOT_FOUND -> observation_stale (alert-dismissed).
      // settleIosCapture retries 250ms later; Attempt 2 observes runningBackground
      // and returns Option.none() so foreground following takes over cleanly.
      const fiber = yield* Effect.forkChild(
        settleIosCapture(access.snapshot("dev.contingency.ioslogin"))
      );
      yield* TestClock.adjust("1 second");
      const settled = yield* Fiber.join(fiber);
      expect(Option.isNone(settled)).toBe(true);
      expect(appStateCalls).toBe(2);
      expect(alertCalls).toBe(1);
      expect(snapshotCalls).toHaveLength(2);
      expect(snapshotCalls).toEqual([
        expect.objectContaining({ observeOnly: true }),
        expect.objectContaining({ observeOnly: true }),
      ]);
    })
);

it.effect(
  "withholds alert read when system-alert hint races with backgrounding or passive appState",
  () =>
    Effect.gen(function* systemAlertRaces() {
      // Alert dismissed and another app took foreground before appState ran:
      // never call alert get or a non-observeOnly snapshot.
      const backgroundCalls: unknown[] = [];
      let backgroundAlertCalls = 0;
      const backgrounded = makeIosSessionAccess({
        alert: () => {
          backgroundAlertCalls += 1;
          return Promise.resolve({ items: ["Allow"], message: "Alert" });
        },
        appState: () =>
          Promise.resolve({
            appBundleId: "dev.contingency.ioslogin",
            appName: "dev.contingency.ioslogin",
            device_udid: "session-simulator",
            platform: "ios" as const,
            source: "runner" as const,
            state: "runningBackgroundSuspended" as const,
            surface: "app" as const,
          }),
        open: () => Promise.resolve({}),
        options: () => ({
          platform: "ios",
          requestId: "capture",
          udid: "session-simulator",
        }),
        snapshot: (options) => {
          backgroundCalls.push(options);
          return Promise.reject(systemAlertUnavailableError());
        },
      });
      expect(
        Option.isNone(yield* backgrounded.snapshot("dev.contingency.ioslogin"))
      ).toBe(true);
      expect(backgroundCalls).toHaveLength(1);
      expect(backgroundAlertCalls).toBe(0);

      // Passive session metadata on a system-alert hint fails as observation_stale
      // so settleIosCapture retries rather than pausing with foreground_app_unknown.
      const passiveCalls: unknown[] = [];
      let passiveAlertCalls = 0;
      const passive = makeIosSessionAccess({
        alert: () => {
          passiveAlertCalls += 1;
          return Promise.resolve({ items: ["Allow"], message: "Alert" });
        },
        appState: () =>
          Promise.resolve({
            appBundleId: "dev.contingency.ioslogin",
            appName: "dev.contingency.ioslogin",
            device_udid: "session-simulator",
            platform: "ios" as const,
            source: "session" as const,
            surface: "app" as const,
          }),
        open: () => Promise.resolve({}),
        options: () => ({
          platform: "ios",
          requestId: "capture",
          udid: "session-simulator",
        }),
        snapshot: (options) => {
          passiveCalls.push(options);
          return Promise.reject(systemAlertUnavailableError());
        },
      });
      const passiveFailure = yield* Effect.flip(
        passive.snapshot("dev.contingency.ioslogin")
      );
      expect(passiveFailure.code).toBe("observation_stale");
      expect(passiveFailure.message).toContain("app-state-unverified");
      expect(passiveCalls).toHaveLength(1);
      expect(passiveAlertCalls).toBe(0);
    })
);

it("maps alert get buttons with real bounds and exact label/message bindings for every button", () => {
  // Two-button notifications alert with scaled bounds.
  const notifications = iosAlertNodes(
    {
      buttons: [
        {
          label: "Don’t Allow",
          rect: { height: 44, width: 135, x: 66, y: 450 },
        },
        {
          label: "Allow",
          rect: { height: 44, width: 135, x: 201, y: 450 },
        },
      ],
      items: ["Don’t Allow", "Allow"],
      message:
        "“Contingency Public Login” Would Like to Send You Notifications",
      rect: { height: 150, width: 270, x: 66, y: 344 },
      referenceHeight: 874,
      referenceWidth: 402,
    },
    "dev.contingency.ioslogin",
    3,
    { sx: 3, sy: 3 }
  );
  expect([...notifications.actions.entries()]).toEqual([
    [
      "@alert-1~a3",
      {
        buttonIndex: 0,
        buttonLabel: "Don’t Allow",
        expectedMessage:
          "“Contingency Public Login” Would Like to Send You Notifications",
      },
    ],
    [
      "@alert-2~a3",
      {
        buttonIndex: 1,
        buttonLabel: "Allow",
        expectedMessage:
          "“Contingency Public Login” Would Like to Send You Notifications",
      },
    ],
  ]);
  expect(notifications.nodes).toEqual([
    expect.objectContaining({
      bounds: { height: 450, width: 810, x: 198, y: 1032 },
      covered: false,
      hittable: false,
      name: "“Contingency Public Login” Would Like to Send You Notifications",
      packageName: "dev.contingency.ioslogin",
      role: "alert",
      target: "@alert-0~a3",
    }),
    expect.objectContaining({
      bounds: { height: 132, width: 405, x: 198, y: 1350 },
      covered: false,
      hittable: true,
      name: "Don’t Allow",
      role: "button",
      target: "@alert-1~a3",
    }),
    expect.objectContaining({
      bounds: { height: 132, width: 405, x: 603, y: 1350 },
      covered: false,
      hittable: true,
      name: "Allow",
      role: "button",
      target: "@alert-2~a3",
    }),
  ]);

  // Three-button location alert: every button, including Allow Once, is
  // uncovered, hittable, bounded, and targeted by its own label + message.
  const location = iosAlertNodes(
    {
      buttons: [
        {
          label: "Allow Once",
          rect: { height: 44, width: 270, x: 66, y: 460 },
        },
        {
          label: "Allow While Using App",
          rect: { height: 44, width: 270, x: 66, y: 504 },
        },
        {
          label: "Don’t Allow",
          rect: { height: 44, width: 270, x: 66, y: 548 },
        },
      ],
      items: ["Allow Once", "Allow While Using App", "Don’t Allow"],
      message: "Allow “Contingency Widgets” to use your location?",
      rect: { height: 248, width: 270, x: 66, y: 344 },
    },
    "dev.contingency.ioswidgets",
    4,
    { sx: 1, sy: 1 }
  );
  expect([...location.actions.entries()]).toEqual([
    [
      "@alert-1~a4",
      {
        buttonIndex: 0,
        buttonLabel: "Allow Once",
        expectedMessage: "Allow “Contingency Widgets” to use your location?",
      },
    ],
    [
      "@alert-2~a4",
      {
        buttonIndex: 1,
        buttonLabel: "Allow While Using App",
        expectedMessage: "Allow “Contingency Widgets” to use your location?",
      },
    ],
    [
      "@alert-3~a4",
      {
        buttonIndex: 2,
        buttonLabel: "Don’t Allow",
        expectedMessage: "Allow “Contingency Widgets” to use your location?",
      },
    ],
  ]);
  expect(location.nodes[1]).toMatchObject({
    bounds: { height: 44, width: 270, x: 66, y: 460 },
    covered: false,
    hittable: true,
    name: "Allow Once",
    role: "button",
    target: "@alert-1~a4",
  });
  expect(location.nodes[2]).toMatchObject({
    bounds: { height: 44, width: 270, x: 66, y: 504 },
    covered: false,
    hittable: true,
    name: "Allow While Using App",
    role: "button",
    target: "@alert-2~a4",
  });
  expect(location.nodes[3]).toMatchObject({
    bounds: { height: 44, width: 270, x: 66, y: 548 },
    covered: false,
    hittable: true,
    name: "Don’t Allow",
    role: "button",
    target: "@alert-3~a4",
  });
});

it("forces a fresh alert screenshot when alert get reports a changed reference viewport", () => {
  const cachedPixels = { height: 2622, width: 1206 };
  const cachedScale = { sx: 3, sy: 3 };
  const cachedWindow = { height: 874, width: 402 };

  // Image-free alert capture reuses cached geometry when reference viewport matches.
  expect(
    canSkipIosAlertScreenshot({
      alert: { referenceHeight: 874, referenceWidth: 402 },
      cachedPixels,
      cachedScale,
      cachedWindow,
      includeImage: false,
    })
  ).toBe(true);

  // Geometry change while an alert is visible (e.g., rotation to landscape)
  // invalidates the screenshot skip so scale and pixel frame are refreshed.
  expect(
    canSkipIosAlertScreenshot({
      alert: { referenceHeight: 402, referenceWidth: 874 },
      cachedPixels,
      cachedScale,
      cachedWindow,
      includeImage: false,
    })
  ).toBe(false);

  // Requesting an image or lacking cached window geometry never skips.
  expect(
    canSkipIosAlertScreenshot({
      alert: { referenceHeight: 874, referenceWidth: 402 },
      cachedPixels,
      cachedScale,
      cachedWindow,
      includeImage: true,
    })
  ).toBe(false);
  expect(
    canSkipIosAlertScreenshot({
      alert: { referenceHeight: 874, referenceWidth: 402 },
      cachedPixels,
      cachedScale,
      cachedWindow: null,
      includeImage: false,
    })
  ).toBe(false);
});

it("classifies replaced or missing alert press refusals as retriable target_changed", () => {
  expect(
    iosAlertActivateFailure(
      new AppError(
        "COMMAND_FAILED",
        "alert message did not match expected message",
        {
          dispatched: "no",
          reason: "alert_mismatch",
          runnerErrorCode: "ALERT_MISMATCH",
        }
      )
    )
  ).toMatchObject({ code: "target_changed", operation: "activate" });
  expect(
    iosAlertActivateFailure(
      new AppError("COMMAND_FAILED", "alert press button not found", {
        dispatched: "no",
        runnerErrorCode: "ALERT_BUTTON_NOT_FOUND",
      })
    )
  ).toMatchObject({ code: "target_changed", operation: "activate" });
  expect(
    iosAlertActivateFailure(
      new AppError("COMMAND_FAILED", "alert not found", {
        dispatched: "no",
        reason: "alert-not-found",
        runnerErrorCode: "ALERT_NOT_FOUND",
      })
    )
  ).toMatchObject({ code: "target_changed", operation: "activate" });
  expect(
    iosAlertActivateFailure(new AppError("COMMAND_FAILED", "transport down"))
  ).toMatchObject({ code: "runtime_failed", operation: "activate" });
});

it("observes again when the bound app leaves the front mid-capture", () => {
  expect(
    iosSnapshotFailure(new AppError("OBSERVATION_UNAVAILABLE", "background"))
  ).toMatchObject({ code: "observation_stale", operation: "capture" });
});

it.effect("binds the session to an app without relaunching it", () =>
  Effect.gen(function* bindsApp() {
    const calls: unknown[] = [];
    const access = makeIosSessionAccess({
      open: (options) => {
        calls.push(options);
        return Promise.resolve({});
      },
      options: () => ({
        platform: "ios",
        requestId: "bind",
        udid: "session-simulator",
      }),
      snapshot: () => Promise.resolve("observed"),
    });
    yield* access.bind("com.apple.springboard");
    expect(calls).toEqual([
      expect.objectContaining({
        app: "com.apple.springboard",
        platform: "ios",
        relaunch: false,
        udid: "session-simulator",
      }),
    ]);
    expect(yield* access.snapshot()).toEqual(
      Option.some({ _tag: "snapshot", snapshot: "observed" })
    );
  })
);

it("accepts any bound app and observes again once it leaves the front", () => {
  const foreground = {
    appBundleId: "com.apple.Preferences",
    appName: "Settings",
    device_udid: "session-simulator",
    platform: "ios",
    source: "runner",
    state: "runningForeground",
    surface: "app",
  } as const;
  expect(iosAppStateProblem(foreground, "session-simulator")).toBeNull();
  expect(
    iosAppStateProblem(
      { ...foreground, appBundleId: "com.apple.springboard" },
      "session-simulator"
    )
  ).toBeNull();
  expect(
    iosAppStateProblem(
      { ...foreground, state: "runningBackground" },
      "session-simulator"
    )
  ).toBe("observation_stale");
  expect(
    iosAppStateProblem(
      { ...foreground, state: "runningBackgroundSuspended" },
      "session-simulator"
    )
  ).toBe("observation_stale");
  expect(
    iosAppStateProblem(
      { ...foreground, source: "session" },
      "session-simulator"
    )
  ).toBe("observation_stale");
  expect(iosAppStateProblem(foreground, "other-simulator")).toBe(
    "device_mismatch"
  );
});

it("names the way back when no app can be named in front", () => {
  expect(iosForegroundUnknown()).toMatchObject({
    code: "foreground_app_unknown",
    operation: "capture",
  });
  expect(iosForegroundUnknown().message).toContain("Press Home");
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
        : Effect.fail(iosRuntimeError("foreground_app_unknown"));
    });
    const failure = yield* Effect.flip(
      observeIosPostAction(capture, screen(0))
    );
    expect(failure.code).toBe("foreground_app_unknown");
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
        : Effect.fail(iosRuntimeError("foreground_app_unknown"));
    });
    const failure = yield* Effect.flip(observeIosPostAction(capture, before));
    expect(failure.code).toBe("foreground_app_unknown");
    expect(calls).toBe(3);
  })
);

it.effect("does not capture again after the first post-action refusal", () =>
  Effect.gen(function* preservesInitialRefusal() {
    const source = sequence(["foreground_app_unknown", "observed"]);
    const capture = source.capture.pipe(Effect.as(screen(1)));
    const failure = yield* Effect.flip(
      observeIosPostAction(capture, screen(0))
    );
    expect(failure.code).toBe("foreground_app_unknown");
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
        const problem = iosAppStateProblem(state, "selected");
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
        "selected"
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
  expect(iosAppStateProblem({ ...state, source: "runner" }, "selected")).toBe(
    "observation_stale"
  );
  expect(
    iosAppStateProblem(
      { ...state, source: "session", state: "runningForeground" },
      "selected"
    )
  ).toBe("observation_stale");
});

it("skips iOS PNG capture only when image is false and window geometry matches the verified cache", () => {
  const portrait = { height: 874, width: 402 };
  const landscape = { height: 402, width: 874 };
  const pixels = { height: 2622, width: 1206 };
  const scale = { sx: 3, sy: 3 };
  expect(
    canSkipIosScreenshot({
      cachedPixels: pixels,
      cachedScale: scale,
      cachedWindow: portrait,
      includeImage: false,
      viewport: portrait,
    })
  ).toBe(true);
  // Explicit image request always captures.
  expect(
    canSkipIosScreenshot({
      cachedPixels: pixels,
      cachedScale: scale,
      cachedWindow: portrait,
      includeImage: true,
      viewport: portrait,
    })
  ).toBe(false);
  // Missing cache (initial capture, rotation, recovery, or app switch) always captures.
  expect(
    canSkipIosScreenshot({
      cachedPixels: null,
      cachedScale: scale,
      cachedWindow: portrait,
      includeImage: false,
      viewport: portrait,
    })
  ).toBe(false);
  // Changed viewport dimensions (rotation or foldable transition) always captures.
  expect(
    canSkipIosScreenshot({
      cachedPixels: pixels,
      cachedScale: scale,
      cachedWindow: portrait,
      includeImage: false,
      viewport: landscape,
    })
  ).toBe(false);
});
