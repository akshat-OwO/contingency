import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { requireAndroidDeviceIdentity } from "../../src/services/android-device-identity.ts";
import { makeAndroidDiscovery } from "../../src/services/android-discovery.ts";
import { acquireAndroidBackend } from "../../src/services/android-runtime-backend.ts";
import { makeAndroidRuntimeFactory } from "../../src/services/android-runtime.ts";

const device = {
  api: 36,
  fingerprint: "build",
  host: "local",
  kind: "physical",
  model: "Phone",
  serial: "phone",
} as const;

it.effect("refuses physical app discovery before issuing commands", () =>
  Effect.gen(function* discoveryRefusal() {
    const discovery = makeAndroidDiscovery({
      adb: () => Effect.die("unexpected device command"),
      readApk: () => Effect.die("unexpected APK read"),
    });
    expect((yield* Effect.flip(discovery.apps(device))).code).toBe(
      "physical_device_unsupported"
    );
  })
);
it.effect("lists connected phones without issuing device commands", () =>
  Effect.gen(function* inventoryRefusal() {
    const discovery = makeAndroidDiscovery({
      adb: (args) => {
        expect(args).toEqual(["devices", "-l"]);
        return Effect.succeed(
          "List of devices attached\nphone device model:Phone\n"
        );
      },
      readApk: () => Effect.die("unexpected APK read"),
    });
    expect(yield* discovery.devices()).toEqual([
      {
        api: null,
        avd: null,
        fingerprint: null,
        kind: "physical",
        model: null,
        release: null,
        serial: "phone",
        state: "device",
      },
    ]);
  })
);
it.effect("refuses physical startup and identity before issuing commands", () =>
  Effect.gen(function* startupRefusal() {
    const input = {
      device,
      platform: "android" as const,
      requiredCapabilities: [],
      scope: yield* Effect.scope,
      targetApp: "dev.fixture",
    };
    expect(
      (yield* Effect.flip(makeAndroidRuntimeFactory().start(input))).code
    ).toBe("physical_device_unsupported");
    expect((yield* Effect.flip(acquireAndroidBackend(input))).code).toBe(
      "physical_device_unsupported"
    );
    expect(
      (yield* Effect.flip(
        requireAndroidDeviceIdentity(device, () =>
          Effect.die("unexpected device command")
        )
      )).code
    ).toBe("physical_device_unsupported");
  }).pipe(Effect.scoped)
);
