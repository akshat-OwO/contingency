import { Effect } from "effect";

import type { AndroidDeviceSelection } from "./android-runtime-contract.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

/** This experimental runtime supports only the owner profile. Unknown users fail closed. */
export const requireAndroidOwnerUser = (
  adb: (args: readonly string[]) => Effect.Effect<string, PlatformRuntimeError>
) =>
  Effect.gen(function* ownerUser() {
    const user = yield* adb(["shell", "am", "get-current-user"]);
    if (user !== "0") {
      return yield* Effect.fail(
        platformRuntimeError("user_profile_unsupported")
      );
    }
  });

/** Recheck immediately before dispatch; callers explicitly scope mutations to user 0. */
export const runAndroidOwnerCommand = (
  adb: (args: readonly string[]) => Effect.Effect<string, PlatformRuntimeError>,
  args: readonly string[]
) => requireAndroidOwnerUser(adb).pipe(Effect.flatMap(() => adb(args)));

/** Discovery never selects a device. Every read uses the caller's selected serial. */
export const requireAndroidDeviceIdentity = (
  device: AndroidDeviceSelection,
  adb: (args: readonly string[]) => Effect.Effect<string, PlatformRuntimeError>
) =>
  Effect.gen(function* identity() {
    const read = (args: readonly string[]) =>
      adb(args).pipe(
        Effect.mapError(() => platformRuntimeError("device_disconnected"))
      );
    if ((yield* read(["get-state"])) !== "device") {
      return yield* Effect.fail(platformRuntimeError("device_disconnected"));
    }
    yield* requireAndroidOwnerUser(read);
    const fingerprint = yield* read([
      "shell",
      "getprop",
      "ro.build.fingerprint",
    ]);
    const api = yield* read(["shell", "getprop", "ro.build.version.sdk"]);
    const emulator = yield* read(["shell", "getprop", "ro.kernel.qemu"]);
    const name =
      device.kind === "physical"
        ? yield* read(["shell", "getprop", "ro.product.model"])
        : (yield* read(["emu", "avd", "name"])).split(/\r?\n/u)[0];
    if (
      fingerprint !== device.fingerprint ||
      api !== String(device.api) ||
      (device.kind === "physical"
        ? emulator === "1" || name !== device.model
        : emulator !== "1" || name !== device.avd)
    ) {
      return yield* Effect.fail(platformRuntimeError("device_mismatch"));
    }
  });
