import { expect, it } from "@effect/vitest";
import { Effect, Scope } from "effect";

import type { AndroidRunInput } from "../../src/services/android-run-contract.ts";
import { createAndroidRun } from "../../src/services/android-run.ts";
import type {
  AndroidObservation,
  AndroidRuntimeBackend,
} from "../../src/services/android-runtime-contract.ts";
import { adaptAndroidRuntime } from "../../src/services/android-runtime.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";

const request = (scope: Scope.Scope): AndroidRunInput => ({
  device: {
    api: 36,
    avd: "fixture",
    fingerprint: "fixture-build",
    host: "local",
    serial: "emulator-5554",
  },
  environment: {
    androidVersion: "16",
    appBuild: "2",
    appId: "dev.fixture",
    startingState: "fresh home",
  },
  platform: "android",
  requiredCapabilities: ["semantic-actions", "screenshots"],
  reversibleActions: [{ name: "Edit", role: "button" }],
  scope,
  setup: {
    activity: "dev.fixture/.Home",
    conditions: [{ name: "Edit", role: "button" }],
    kind: "restart-activity",
  },
  targetApp: "dev.fixture",
  taught: {
    capabilities: ["semantic-actions", "screenshots"],
    environment: {
      androidVersion: "15",
      appBuild: "1",
      appId: "dev.old",
      startingState: "old home",
    },
    platform: "android",
  },
});

const fixture = () =>
  Effect.gen(function* makeFixture() {
    const input = request(yield* Scope.Scope);
    const calls: string[] = [];
    let identity = true;
    let owned = true;
    let starting = true;
    let generation = 0;
    const backend: AndroidRuntimeBackend = {
      activate: () =>
        Effect.sync(() => {
          calls.push("activate");
        }),
      back: () => Effect.void,
      capture: () =>
        Effect.sync((): AndroidObservation => {
          generation += 1;
          return {
            backendSessionId: "fixture-session",
            capture: {
              complete: true,
              mode: "interactive-windows",
              secureWindowVisibility: "unverified",
              windowCount: 1,
            },
            device: input.device,
            generation,
            id: `observation-${generation}`,
            nodes: [
              {
                covered: false,
                editable: false,
                hittable: true,
                name: starting ? "Edit" : "Wrong screen",
                packageName: "dev.fixture",
                password: false,
                role: "button",
                target: "@e1",
              },
            ],
            ownership: {
              focusedPackage: "dev.fixture",
              kind: "experimental-host-check",
              systemDialogAuthority: "unsupported",
            },
            platform: "android",
            screenshot: {
              capturedAt: "2026-10-13",
              encoding: "base64",
              format: "png",
              image: "sensitive-pixels",
            },
          };
        }),
      close: () =>
        Effect.sync(() => {
          calls.push("close");
        }),
      enterPrivate: () =>
        Effect.fail(platformRuntimeError("capability_missing")),
      fill: () => Effect.void,
      recover: () => Effect.void,
      sessionId: "fixture-session",
      validate: () =>
        owned
          ? Effect.void
          : Effect.fail(platformRuntimeError("ownership_unknown")),
    };
    const driver = {
      preflight: () =>
        identity
          ? Effect.void
          : Effect.fail(platformRuntimeError("environment_changed")),
      start: (startup: AndroidRunInput) =>
        Effect.sync(() => {
          calls.push("setup");
        }).pipe(Effect.andThen(adaptAndroidRuntime({ backend, startup }))),
    };
    return {
      calls,
      changeBuild: () => {
        identity = false;
      },
      driver,
      failStarting: () => {
        starting = false;
      },
      input,
      leaveApp: () => {
        owned = false;
      },
      returnApp: () => {
        owned = true;
      },
    };
  });

it.effect(
  "retains all differences and grants only the pending decision of one Run",
  () =>
    Effect.gen(function* permissions() {
      const { calls, driver, input } = yield* fixture();
      const history = structuredClone(input.taught);
      const run = yield* createAndroidRun(input, driver);
      expect(
        run.state().differences.map((difference) => difference.field)
      ).toEqual(["androidVersion", "appBuild", "appId", "startingState"]);
      const [decision] = run.state().pending;
      expect(decision?.targetApp).toBe("dev.fixture");
      expect((yield* Effect.flip(run.prepare())).code).toBe(
        "preparation_required"
      );
      expect(calls).toEqual([]);
      yield* run.decide(decision?.id ?? "", true);
      expect(
        (yield* Effect.flip(run.decide(decision?.id ?? "", true))).code
      ).toBe("permission_stale");
      const before = yield* run.prepare();
      yield* run.dispatch(before.id, { target: "@e1", type: "activate" });
      expect(calls).toEqual(["setup", "activate"]);
      expect(input.taught).toEqual(history);
      expect(JSON.stringify(run.state())).not.toContain("sensitive-pixels");
      const next = yield* createAndroidRun(input, driver);
      expect(
        (yield* Effect.flip(next.decide(decision?.id ?? "", true))).code
      ).toBe("permission_stale");
      expect(next.state().pending).toHaveLength(1);
    })
);

it.effect("refusal blocks preparation, input, and recovery permanently", () =>
  Effect.gen(function* refusal() {
    const { calls, driver, input } = yield* fixture();
    const run = yield* createAndroidRun(input, driver);
    yield* run.decide(run.state().pending[0]?.id ?? "", false);
    yield* Effect.flip(run.prepare());
    yield* Effect.flip(
      run.dispatch("unused", { target: "@e1", type: "activate" })
    );
    yield* Effect.flip(run.recover());
    expect(run.state().phase).toBe("refused");
    expect(run.state().evidence.at(-1)?.type).toBe("refusal");
    expect(calls).toEqual([]);
  })
);

it.effect(
  "a grant cannot waive selected-build drift or failed starting conditions",
  () =>
    Effect.gen(function* failures() {
      const f = yield* fixture();
      const run = yield* createAndroidRun(f.input, f.driver);
      yield* run.decide(run.state().pending[0]?.id ?? "", true);
      f.changeBuild();
      expect((yield* Effect.flip(run.prepare())).code).toBe(
        "environment_changed"
      );
      expect(f.calls).toEqual([]);
      const g = yield* fixture();
      const failed = yield* createAndroidRun(g.input, g.driver);
      yield* failed.decide(failed.state().pending[0]?.id ?? "", true);
      g.failStarting();
      expect((yield* Effect.flip(failed.prepare())).code).toBe(
        "starting_condition_failed"
      );
      yield* Effect.flip(failed.recover());
      expect(g.calls).toEqual(["setup", "close"]);
      expect(failed.state().phase).toBe("paused");
    })
);

it.effect(
  "unexpected app pauses input and explicit recovery produces new evidence without replay",
  () =>
    Effect.gen(function* recovery() {
      const f = yield* fixture();
      const run = yield* createAndroidRun(f.input, f.driver);
      yield* run.decide(run.state().pending[0]?.id ?? "", true);
      const before = yield* run.prepare();
      f.leaveApp();
      expect(
        (yield* Effect.flip(
          run.dispatch(before.id, { target: "@e1", type: "activate" })
        )).code
      ).toBe("ownership_unknown");
      expect(run.state().phase).toBe("paused");
      f.returnApp();
      const fresh = yield* run.recover();
      expect(fresh.id).not.toBe(before.id);
      expect(f.calls).toEqual(["setup"]);
      yield* run.close();
      yield* run.close();
      yield* Effect.flip(run.recover());
      expect(run.state().phase).toBe("closed");
      expect(f.calls).toEqual(["setup", "close"]);
    })
);

it.effect(
  "rejects web history, unsupported capabilities, outside-app setup, and absent freshness checks",
  () =>
    Effect.gen(function* unsupported() {
      const { calls, driver, input } = yield* fixture();
      const invalid = [
        {
          ...input,
          taught: {
            capabilities: [],
            environment: { engine: "chromium" as const },
            platform: "web" as const,
          },
        },
        {
          ...input,
          requiredCapabilities: [
            ...input.requiredCapabilities,
            "coordinate-actions" as const,
          ],
        },
        { ...input, setup: { ...input.setup, activity: "dev.outside/.Home" } },
        { ...input, setup: { ...input.setup, conditions: [] } },
      ];
      for (const attempt of invalid) {
        yield* Effect.flip(createAndroidRun(attempt, driver));
      }
      expect(calls).toEqual([]);
    })
);

it.effect(
  "installation approval is separate and no undeclared activation is dispatched",
  () =>
    Effect.gen(function* installDecision() {
      const { calls, driver, input } = yield* fixture();
      const run = yield* createAndroidRun(
        {
          ...input,
          appInstallation: { apk: "/fixture.apk", sha256: "a".repeat(64) },
          reversibleActions: [],
        },
        driver
      );
      expect(run.state().pending.map((decision) => decision.kind)).toEqual([
        "run-environment-permission",
        "app-installation",
      ]);
      const decisions = run.state().pending;
      yield* run.decide(decisions[0]?.id ?? "", true);
      yield* Effect.flip(run.prepare());
      expect(calls).toEqual([]);
      yield* run.decide(decisions[1]?.id ?? "", true);
      const before = yield* run.prepare();
      expect(
        (yield* Effect.flip(
          run.dispatch(before.id, { target: "@e1", type: "activate" })
        )).code
      ).toBe("target_unsupported");
      expect(calls).toEqual(["setup"]);
    })
);

it.effect(
  "copies declarations and decisions so retained caller references cannot change authority",
  () =>
    Effect.gen(function* immutableAuthority() {
      const { driver, input } = yield* fixture();
      const run = yield* createAndroidRun(input, driver);
      const pending = run.state();
      const decisionId = pending.pending[0]?.id ?? "";
      Object.assign(pending, { pending: [], phase: "ready" });
      Object.assign(input.environment, { appId: "dev.outside" });
      expect(run.state().phase).toBe("pending");
      expect(run.state().pending).toHaveLength(1);
      expect(run.state().environment.appId).toBe("dev.fixture");
      yield* run.decide(decisionId, true);
      yield* run.prepare();
    })
);

it.effect(
  "recovery validates the installed build without requiring the original installation file",
  () =>
    Effect.gen(function* installedRecovery() {
      const f = yield* fixture();
      let sourceAvailable = true;
      const run = yield* createAndroidRun(
        {
          ...f.input,
          appInstallation: { apk: "/authorized.apk", sha256: "a".repeat(64) },
        },
        {
          ...f.driver,
          preflight: (_input, phase) =>
            sourceAvailable || phase === "installed"
              ? f.driver.preflight()
              : Effect.fail(platformRuntimeError("preparation_failed")),
        }
      );
      for (const decision of run.state().pending) {
        yield* run.decide(decision.id, true);
      }
      const first = yield* run.prepare();
      sourceAvailable = false;
      f.leaveApp();
      yield* Effect.flip(run.observe());
      f.returnApp();
      const fresh = yield* run.recover();
      expect(fresh.id).not.toBe(first.id);
      expect(f.calls).toEqual(["setup"]);
    })
);

it.effect(
  "requires app-data consent for each physical Run and binds it to the selected device",
  () =>
    Effect.gen(function* physicalConsent() {
      const { driver, input, calls } = yield* fixture();
      const physical: AndroidRunInput = {
        ...input,
        device: {
          api: 36,
          fingerprint: "phone-build",
          host: "local",
          kind: "physical",
          model: "A059",
          serial: "phone-serial",
        },
        setup: { ...input.setup, kind: "clear-app-data" },
      };
      let started: AndroidRunInput | undefined;
      const run = yield* createAndroidRun(physical, {
        ...driver,
        start: (selected) => {
          started = selected;
          return driver.start(selected);
        },
      });
      const consent = run
        .state()
        .pending.find((decision) => decision.kind === "clear-app-data");
      expect(consent?.serial).toBe("phone-serial");
      expect(consent?.targetApp).toBe("dev.fixture");
      for (const decision of run
        .state()
        .pending.filter((entry) => entry.kind !== "clear-app-data")) {
        yield* run.decide(decision.id, true);
      }
      expect((yield* Effect.flip(run.prepare())).code).toBe(
        "preparation_required"
      );
      expect(calls).toEqual([]);
      yield* run.decide(consent?.id ?? "", true);
      yield* run.prepare();
      expect(started?.clearDataGrant).toEqual({
        serial: "phone-serial",
        targetApp: "dev.fixture",
      });
      yield* run.close();
      const next = yield* createAndroidRun(physical, driver);
      const nextConsent = next
        .state()
        .pending.find((entry) => entry.kind === "clear-app-data");
      expect(nextConsent?.id).not.toBe(consent?.id);
      yield* next.decide(nextConsent?.id ?? "", false);
      expect(next.state().phase).toBe("refused");
      expect((yield* Effect.flip(next.prepare())).code).toBe(
        "preparation_required"
      );
      expect(calls).toEqual(["setup", "close"]);
    }).pipe(Effect.scoped)
);

it.effect(
  "records permission differences without rewriting the taught environment",
  () =>
    Effect.gen(function* permissionDifference() {
      const { driver, input } = yield* fixture();
      const run = yield* createAndroidRun(
        {
          ...input,
          environment: {
            ...input.environment,
            permissions: [
              {
                decision: "revoke",
                permission: "android.permission.POST_NOTIFICATIONS",
              },
            ],
          },
        },
        driver
      );
      expect(
        run.state().differences.find((entry) => entry.field === "permissions")
          ?.selected
      ).toContain("revoke");
      expect(run.state().taught).toEqual(input.taught);
    }).pipe(Effect.scoped)
);

it.effect(
  "refuses permission decisions below API 31 before any device command",
  () =>
    Effect.gen(function* permissionApi() {
      const { driver, input, calls } = yield* fixture();
      const result = yield* Effect.flip(
        createAndroidRun(
          {
            ...input,
            device: { ...input.device, api: 30 },
            environment: {
              ...input.environment,
              permissions: [
                { decision: "grant", permission: "android.permission.CAMERA" },
              ],
            },
          },
          driver
        )
      );
      expect(result.code).toBe("permission_decisions_unsupported");
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped)
);

it.effect("refuses a physical Run that only restarts an activity", () =>
  Effect.gen(function* physicalFreshness() {
    const { driver, input, calls } = yield* fixture();
    const result = yield* Effect.flip(
      createAndroidRun(
        {
          ...input,
          device: {
            api: 36,
            fingerprint: "phone-build",
            host: "local",
            kind: "physical",
            model: "A059",
            serial: "phone-serial",
          },
        },
        driver
      )
    );
    expect(result.code).toBe("preparation_failed");
    expect(calls).toEqual([]);
  }).pipe(Effect.scoped)
);
