import { Effect, Schema } from "effect";

import type { IosDevice } from "./ios-contract.ts";
import {
  IosDeviceSchema,
  iosError,
  iosUuid,
  isSupportedIosVersion,
} from "./ios-contract.ts";
import { decodeIosJson, iosSimctlHost } from "./ios-simctl.ts";
import type { IosSimctlService } from "./ios-simctl.ts";

const Runtimes = Schema.Struct({
  runtimes: Schema.Array(
    Schema.Struct({
      identifier: Schema.String,
      isAvailable: Schema.Boolean,
      platform: Schema.optional(Schema.String),
      version: Schema.String,
    })
  ),
});
const Inventory = Schema.Struct({
  devices: Schema.Record(
    Schema.String,
    Schema.Array(
      Schema.Struct({
        dataPath: Schema.String,
        deviceTypeIdentifier: Schema.String,
        isAvailable: Schema.Boolean,
        name: Schema.String,
        state: Schema.String,
        udid: Schema.String,
      })
    )
  ),
});
export const requireIosHost = (io: IosSimctlService) =>
  Effect.gen(function* hostPrerequisites() {
    if (io.platform() !== "darwin" || io.architecture() !== "arm64") {
      return yield* Effect.fail(iosError("host_unsupported"));
    }
    yield* io.xcode().pipe(Effect.mapError(() => iosError("xcode_missing")));
  });
export const requireIosPrerequisites = (
  io: IosSimctlService,
  selected?: IosDevice
) =>
  Effect.gen(function* prerequisites() {
    if (selected !== undefined && selected.kind !== "simulator") {
      return yield* Effect.fail(iosError("physical_device_unsupported"));
    }
    yield* requireIosHost(io);
    if (selected !== undefined) {
      if (!Schema.is(IosDeviceSchema)(selected)) {
        return yield* Effect.fail(iosError("device_unsupported"));
      }
      if (!isSupportedIosVersion(selected.runtimeVersion)) {
        return yield* Effect.fail(iosError("os_unsupported"));
      }
    }
    const { runtimes } = yield* decodeIosJson(
      Runtimes,
      yield* io
        .runtimes()
        .pipe(Effect.mapError(() => iosError("runtime_missing")))
    );
    const installed = runtimes.filter(
      (runtime) =>
        runtime.isAvailable &&
        runtime.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-")
    );
    if (selected === undefined) {
      if (installed.length === 0) {
        return yield* Effect.fail(iosError("runtime_missing"));
      }
      if (
        !installed.some((runtime) => isSupportedIosVersion(runtime.version))
      ) {
        return yield* Effect.fail(iosError("os_unsupported"));
      }
    } else if (
      !installed.some(
        (runtime) =>
          runtime.identifier === selected.runtime &&
          runtime.version === selected.runtimeVersion
      )
    ) {
      return yield* Effect.fail(iosError("runtime_missing"));
    }
    return installed;
  });
/** Starting a simulator fails apart from the runtime's codes. */
const bootFailed = {
  _tag: "IosBootError",
  code: "boot_failed",
  message:
    "Could not start the selected simulator. Check its runtime in Xcode, then try again.",
} as const;
export const makeIosDiscovery = (io: IosSimctlService = iosSimctlHost) => {
  const inventory = (selected?: IosDevice) =>
    Effect.gen(function* readInventory() {
      const runtimes = yield* requireIosPrerequisites(io, selected);
      const { devices } = yield* decodeIosJson(Inventory, yield* io.devices());
      return Object.entries(devices).flatMap(([runtimeId, entries]) => {
        const runtime = runtimes.find(
          (entry) => entry.identifier === runtimeId
        );
        if (runtime === undefined || !isSupportedIosVersion(runtime.version)) {
          return [];
        }
        return entries.flatMap((entry) =>
          entry.isAvailable &&
          entry.deviceTypeIdentifier.startsWith(
            "com.apple.CoreSimulator.SimDeviceType.iPhone-"
          )
            ? [
                {
                  dataPath: entry.dataPath,
                  device: {
                    deviceType: entry.deviceTypeIdentifier,
                    kind: "simulator" as const,
                    name: entry.name,
                    runtime: runtimeId,
                    runtimeVersion: runtime.version,
                    udid: entry.udid,
                  },
                  state: entry.state,
                },
              ]
            : []
        );
      });
    });
  const resolve = (selected: IosDevice | { readonly kind: "physical" }) =>
    Effect.gen(function* resolveSelection() {
      if (selected.kind === "physical") {
        return yield* Effect.fail(iosError("physical_device_unsupported"));
      }
      const entries = yield* inventory(selected);
      const entry = entries.find(
        ({ device }) =>
          device.udid === selected.udid &&
          device.deviceType === selected.deviceType &&
          device.runtime === selected.runtime &&
          device.runtimeVersion === selected.runtimeVersion
      );
      if (entry === undefined) {
        return yield* Effect.fail(iosError("device_mismatch"));
      }
      return entry;
    });
  const requireRunning = (selected: IosDevice) =>
    resolve(selected).pipe(
      Effect.flatMap((entry) =>
        entry.state === "Booted"
          ? Effect.succeed(entry)
          : Effect.fail(iosError("device_stopped"))
      )
    );
  /**
   * Boots an existing matrix simulator by UDID and waits until it has booted.
   * It never creates, clones, erases, or resets one: host refusals come first,
   * and a UDID outside the discovered inventory is refused before `simctl`.
   */
  const boot = (udid: string) =>
    Effect.gen(function* bootSimulator() {
      if (!iosUuid.test(udid)) {
        return yield* Effect.fail(iosError("device_mismatch"));
      }
      const entry = (yield* inventory()).find(
        ({ device }) => device.udid === udid
      );
      if (entry === undefined) {
        return yield* Effect.fail(iosError("device_mismatch"));
      }
      if (entry.state !== "Booted") {
        // `simctl boot` refuses a simulator that is already booting; the
        // bootstatus wait below covers that state.
        if (entry.state === "Shutdown") {
          yield* io
            .device(["boot", udid])
            .pipe(Effect.mapError(() => bootFailed));
        }
        yield* io
          .device(["bootstatus", udid])
          .pipe(Effect.mapError(() => bootFailed));
      }
      return entry.device;
    });
  return {
    apps: (selected: IosDevice) =>
      requireRunning(selected).pipe(
        Effect.flatMap(({ dataPath }) => io.apps(dataPath))
      ),
    boot,
    devices: () =>
      inventory().pipe(
        Effect.map((entries) =>
          entries.map(({ device, state }) => ({ ...device, state }))
        )
      ),
    requireRunning,
    resolve,
  };
};
export const iosDiscovery = makeIosDiscovery();
