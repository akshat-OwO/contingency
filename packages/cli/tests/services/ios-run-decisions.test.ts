import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  createIosRun,
  iosCapabilities,
  iosRunDecisions,
  iosRuntimeError,
  iosSystemKeys,
} from "../../src/services/ios-runtime.ts";
import type { IosRunInput } from "../../src/services/ios-runtime.ts";
import { nativeAppActionPolicy } from "../../src/services/native-app-action-policy.ts";
import { adaptNativeAppRuntime } from "../../src/services/native-app-runtime.ts";
import {
  IOS_WIDGET_SCRIPT,
  corpusIosSimulator,
  makeCorpusNativeBackend,
} from "../helpers/corpus-native-device.ts";

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
            installedBuild: null,
            kind: "app-installation",
            runId: "run",
            targetApp: environment.bundleId,
          },
        ]);
        // Over an installed build, the decision names the build it replaces.
        expect(
          iosRunDecisions(
            { ...input, appPath: "/build/Fixture.app", installedBuild: "0" },
            "run"
          )
        ).toMatchObject([{ installedBuild: "0", kind: "app-installation" }]);
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

it.effect(
  "reads installedBuild afresh on each evaluation of the same createIosRun Effect",
  () =>
    Effect.scoped(
      Effect.gen(function* perExecutionInstalledBuild() {
        const input = {
          ...request(yield* Effect.scope),
          appPath: "/build/Fixture.app",
        };
        let currentBuild = "1";
        let lookups = 0;
        const create = createIosRun(input, {
          installedBuild: () =>
            Effect.sync(() => {
              lookups += 1;
              return currentBuild;
            }),
          preflight: () => Effect.void,
          restart: () => Effect.void,
          start: () => Effect.die("unused"),
        });

        const first = yield* create;
        expect(first.state().pending).toMatchObject([
          { installedBuild: "1", kind: "app-installation" },
        ]);

        currentBuild = "3";
        const second = yield* create;
        expect(second.state().pending).toMatchObject([
          { installedBuild: "3", kind: "app-installation" },
        ]);
        expect(lookups).toBe(2);
      })
    )
);

it.effect(
  "restarts the prepared Target App through the injected restart dependency",
  () =>
    Effect.scoped(
      Effect.gen(function* restartTargetApp() {
        const input: IosRunInput = {
          ...request(yield* Effect.scope),
          device: corpusIosSimulator,
          setup: { conditions: [], kind: "restart-app" },
        };
        const fake = makeCorpusNativeBackend({
          device: corpusIosSimulator,
          platform: "ios",
          script: IOS_WIDGET_SCRIPT,
        });
        const restarts: IosRunInput[] = [];
        const run = yield* createIosRun(input, {
          installedBuild: () => Effect.succeed("1"),
          preflight: () => Effect.void,
          restart: (restarted) =>
            Effect.sync(() => {
              restarts.push(restarted);
            }),
          start: (startup) =>
            adaptNativeAppRuntime({
              backend: fake.backend,
              capabilities: iosCapabilities,
              error: iosRuntimeError,
              policy: nativeAppActionPolicy(iosRuntimeError, iosSystemKeys),
              startup,
            }),
        });

        const beforePrepare = yield* Effect.flip(run.restart());
        expect(beforePrepare.code).toBe("preparation_required");
        expect(restarts).toEqual([]);

        yield* run.prepare();
        const restarted = yield* run.restart();
        expect(restarted.platform).toBe("ios");
        expect(restarts).toHaveLength(1);
        expect(restarts[0]).toMatchObject({
          device: { udid: corpusIosSimulator.udid },
          setup: { conditions: [], kind: "restart-app" },
          targetApp: environment.bundleId,
        });
      })
    )
);
