import { Effect } from "effect";

import type { AndroidDeviceSelection } from "./android-runtime-contract.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

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
