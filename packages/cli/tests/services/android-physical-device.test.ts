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
          "shell am get-current-user": "0",
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
      properties.set("shell am get-current-user", "10");
      expect(
        (yield* Effect.flip(requireAndroidDeviceIdentity(phone, adb))).code
      ).toBe("user_profile_unsupported");
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
          if (command === "shell am get-current-user") {
            return "0";
          }
          return command.includes("dumpsys")
            ? "User 0: installed=true\n android.permission.POST_NOTIFICATIONS: granted=false, flags=[ USER_SET|USER_FIXED ]"
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
        "shell am get-current-user",
        "shell am get-current-user",
        "shell pm clear --user 0 dev.fixture",
        "shell am get-current-user",
        "shell pm revoke --user 0 dev.fixture android.permission.POST_NOTIFICATIONS",
        "shell am get-current-user",
        "shell pm set-permission-flags --user 0 dev.fixture android.permission.POST_NOTIFICATIONS user-set user-fixed",
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

it.effect(
  "refuses an active secondary user before clearing either profile",
  () =>
    Effect.gen(function* secondaryUser() {
      const input = request(yield* Scope.Scope);
      const mutations: string[] = [];
      const failure = yield* Effect.flip(
        prepareAndroidAppData(
          {
            ...input,
            clearDataGrant: {
              serial: phone.serial,
              targetApp: input.targetApp,
            },
          },
          (args) =>
            Effect.sync(() => {
              const command = args.join(" ");
              if (command === "shell am get-current-user") {
                return "10";
              }
              if (command.includes("dumpsys")) {
                return "User 0: installed=true\n android.permission.POST_NOTIFICATIONS: granted=false\nUser 10: installed=true\n android.permission.POST_NOTIFICATIONS: granted=false";
              }
              mutations.push(command);
              return "Success";
            })
        )
      );
      expect(failure.code).toBe("user_profile_unsupported");
      expect(mutations).toEqual([]);
    }).pipe(Effect.scoped)
);

it.effect("reads permissions only from owner user 0", () =>
  Effect.gen(function* ownerPermissions() {
    const input = request(yield* Scope.Scope);
    yield* requireAndroidPermissionState(input, () =>
      Effect.succeed(
        "User 10: installed=true\n android.permission.POST_NOTIFICATIONS: granted=true\nUser 0: installed=true\n android.permission.POST_NOTIFICATIONS: granted=false"
      )
    );
  }).pipe(Effect.scoped)
);

it.effect(
  "refuses a profile switch after consent and before the clear dispatch",
  () =>
    Effect.gen(function* profileSwitch() {
      const input = request(yield* Scope.Scope);
      const calls: string[] = [];
      let reads = 0;
      const failure = yield* Effect.flip(
        prepareAndroidAppData(
          {
            ...input,
            clearDataGrant: {
              serial: phone.serial,
              targetApp: input.targetApp,
            },
          },
          (args) =>
            Effect.sync(() => {
              const command = args.join(" ");
              calls.push(command);
              if (command === "shell am get-current-user") {
                reads += 1;
                return reads === 1 ? "0" : "10";
              }
              return "Success";
            })
        )
      );
      expect(failure.code).toBe("user_profile_unsupported");
      expect(calls).toEqual([
        "shell am get-current-user",
        "shell am get-current-user",
      ]);
    }).pipe(Effect.scoped)
);

it.effect("refuses unknown users and missing owner permission records", () =>
  Effect.gen(function* unknownUser() {
    const input = request(yield* Scope.Scope);
    const failure = yield* Effect.flip(
      prepareAndroidAppData(
        {
          ...input,
          clearDataGrant: { serial: phone.serial, targetApp: input.targetApp },
        },
        () => Effect.succeed("unknown")
      )
    );
    expect(failure.code).toBe("user_profile_unsupported");
    const missingOwner = yield* Effect.flip(
      requireAndroidPermissionState(input, () =>
        Effect.succeed(
          "User 10: installed=true\n android.permission.POST_NOTIFICATIONS: granted=false"
        )
      )
    );
    expect(missingOwner.code).toBe("environment_changed");
  }).pipe(Effect.scoped)
);
