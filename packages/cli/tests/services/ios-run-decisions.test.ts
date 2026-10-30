import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createIosRun,
  iosRunDecisions,
} from "../../src/services/ios-runtime.ts";
import type { IosRunInput } from "../../src/services/ios-runtime.ts";

const environment = {
  build: "1",
  bundleId: "dev.contingency.fixture",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  runtimeVersion: "26.5",
};
const request = (scope: IosRunInput["scope"]): IosRunInput => ({
  device: {
    deviceType: environment.deviceType,
    kind: "simulator",
    name: "Selected simulator",
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    runtimeVersion: "26.5",
    udid: "11111111-1111-1111-1111-111111111111",
  },
  environment,
  platform: "ios",
  requiredCapabilities: [],
  scope,
  setup: { conditions: [{ name: "Login", role: "text" }], kind: "restart-app" },
  targetApp: environment.bundleId,
  taught: { capabilities: [], environment, platform: "ios" },
});

it.effect(
  "requires a separate installation decision even when the environment matches",
  () =>
    Effect.scoped(
      Effect.gen(function* installationDecision() {
        const input = request(yield* Effect.scope);
        expect(iosRunDecisions(input, "run")).toEqual([]);
        const named = iosRunDecisions(
          { ...input, appPath: "/build/Fixture.app" },
          "run"
        );
        expect(named).toMatchObject([
          {
            kind: "app-installation",
            runId: "run",
            targetApp: environment.bundleId,
          },
        ]);
        const changed = iosRunDecisions(
          {
            ...input,
            appPath: "/build/Fixture.app",
            environment: { ...environment, build: "2" },
          },
          "run"
        );
        expect(changed.map((decision) => decision.kind)).toEqual([
          "run-environment-permission",
          "app-installation",
        ]);
        expect(new Set(changed.map((decision) => decision.id)).size).toBe(2);
      })
    )
);

it.effect("refuses an unsupported permission service before preflight", () =>
  Effect.scoped(
    Effect.gen(function* unsupportedService() {
      const input = request(yield* Effect.scope);
      const declared = {
        ...environment,
        permissions: [
          { decision: "revoke", service: "notifications" },
        ] as const,
      };
      const result = yield* Effect.result(
        createIosRun({
          ...input,
          environment: declared,
          taught: { capabilities: [], environment: declared, platform: "ios" },
        })
      );
      expect(result._tag === "Failure" ? result.failure.code : "success").toBe(
        "permission_service_unsupported"
      );
    })
  )
);
