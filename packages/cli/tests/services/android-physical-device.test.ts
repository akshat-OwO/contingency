import { expect, it } from "@effect/vitest";
import { Effect, Scope } from "effect";

import { requireAndroidDeviceIdentity } from "../../src/services/android-device-identity.ts";
import {
  prepareAndroidAppData,
  requireAndroidPermissionState,
} from "../../src/services/android-preparation.ts";
import type { AndroidRunInput } from "../../src/services/android-run-contract.ts";
import { platformRuntimeError } from "../../src/services/platform-runtime-error.ts";

const phone = {
  api: 36,
  fingerprint: "phone-build",
  host: "local",
  kind: "physical",
  model: "A059",
  serial: "phone-serial",
} as const;
const request = (scope: Scope.Scope): AndroidRunInput => ({
  device: phone,
  environment: {
    androidVersion: "16",
    appBuild: "1",
    appId: "dev.fixture",
    permissions: [
      {
        decision: "revoke",
        permission: "android.permission.POST_NOTIFICATIONS",
      },
    ],
    startingState: "fresh",
  },
  platform: "android",
  requiredCapabilities: [],
  scope,
  setup: {
    activity: "dev.fixture/.Home",
    conditions: [{ name: "Fresh", role: "text" }],
    kind: "clear-app-data",
  },
  targetApp: "dev.fixture",
  taught: {
    capabilities: [],
    environment: {
      androidVersion: "16",
      appBuild: "1",
      appId: "dev.fixture",
      startingState: "fresh",
    },
    platform: "android",
  },
});

it.effect(
  "validates physical identity without emulator commands and refuses changed hardware",
  () =>
    Effect.gen(function* validatePhone() {
      const reads: string[] = [];
      const properties = new Map<string, string>(
        Object.entries({
          "get-state": "device",
          "shell getprop ro.build.fingerprint": "phone-build",
          "shell getprop ro.build.version.sdk": "36",
          "shell getprop ro.kernel.qemu": "",
          "shell getprop ro.product.model": "A059",
        })
      );
      const adb = (args: readonly string[]) =>
        Effect.sync(() => {
          const command = args.join(" ");
          reads.push(command);
          return properties.get(command) ?? "";
        });
      yield* requireAndroidDeviceIdentity(phone, adb);
      expect(reads.some((command) => command.startsWith("emu "))).toBe(false);
      properties.set("shell getprop ro.product.model", "another-phone");
      expect(
        (yield* Effect.flip(requireAndroidDeviceIdentity(phone, adb))).code
      ).toBe("device_mismatch");
      expect(
        (yield* Effect.flip(
          requireAndroidDeviceIdentity(phone, () =>
            Effect.fail(platformRuntimeError("preparation_failed"))
          )
        )).code
      ).toBe("device_disconnected");
      properties.set("get-state", "offline");
      expect(
        (yield* Effect.flip(requireAndroidDeviceIdentity(phone, adb))).code
      ).toBe("device_disconnected");
    })
);

it.effect(
  "refuses missing or wrong-device app-data consent before any mutation",
  () =>
    Effect.gen(function* refuseClear() {
      const input = request(yield* Scope.Scope);
      const calls: string[][] = [];
      const adb = (args: readonly string[]) =>
        Effect.sync(() => {
          calls.push([...args]);
          return "Success";
        });
      expect((yield* Effect.flip(prepareAndroidAppData(input, adb))).code).toBe(
        "clear_data_denied"
      );
      expect(
        (yield* Effect.flip(
          prepareAndroidAppData(
            {
              ...input,
              clearDataGrant: {
                serial: "another-phone",
                targetApp: input.targetApp,
              },
            },
            adb
          )
        )).code
      ).toBe("clear_data_denied");
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped)
);

it.effect(
  "clears only the authorized app and establishes the declared denial before launch",
  () =>
    Effect.gen(function* prepareClear() {
      const input = request(yield* Scope.Scope);
      const calls: string[] = [];
      const adb = (args: readonly string[]) =>
        Effect.sync(() => {
          const command = args.join(" ");
          calls.push(command);
          return command.includes("dumpsys")
            ? "android.permission.POST_NOTIFICATIONS: granted=false, flags=[ USER_SET|USER_FIXED ]"
            : "Success";
        });
      yield* prepareAndroidAppData(
        {
          ...input,
          clearDataGrant: { serial: phone.serial, targetApp: input.targetApp },
        },
        adb
      );
      expect(calls).toEqual([
        "shell pm clear dev.fixture",
        "shell pm revoke dev.fixture android.permission.POST_NOTIFICATIONS",
        "shell pm set-permission-flags dev.fixture android.permission.POST_NOTIFICATIONS user-set user-fixed",
        "shell dumpsys package dev.fixture",
      ]);
      const failed = yield* Effect.flip(
        prepareAndroidAppData(
          {
            ...input,
            clearDataGrant: {
              serial: phone.serial,
              targetApp: input.targetApp,
            },
          },
          () => Effect.fail(platformRuntimeError("device_disconnected"))
        )
      );
      expect(failed.code).toBe("device_disconnected");
    }).pipe(Effect.scoped)
);

it.effect(
  "pauses when a recorded permission drifts and does not silently reapply it",
  () =>
    Effect.gen(function* drift() {
      const input = request(yield* Scope.Scope);
      const observed: string[][] = [];
      const failure = yield* Effect.flip(
        requireAndroidPermissionState(input, (args) =>
          Effect.sync(() => {
            observed.push([...args]);
            return "android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]";
          })
        )
      );
      expect(failure.code).toBe("environment_changed");
      expect(observed).toEqual([
        ["shell", "dumpsys", "package", "dev.fixture"],
      ]);
    }).pipe(Effect.scoped)
);
