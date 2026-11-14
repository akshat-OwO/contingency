import type {
  DeviceErasePlatform,
  DeviceEraseRequest,
  DeviceEraseState,
} from "@contingency/protocol";
import { OperationId } from "@contingency/protocol";
import { Context, Effect, Layer } from "effect";

import { makeAndroidDeviceBoot } from "./android-device-boot.ts";
import type {
  AndroidBootError,
  OwnedDeviceOutcome,
} from "./android-device-boot.ts";
import type { IosDevice, IosError } from "./ios-contract.ts";
import { makeIosDeviceBoot } from "./ios-device-boot.ts";

type IosBootFailure =
  | IosError
  | { readonly code: string; readonly message: string };

export interface DeviceEraseFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * Starts emulators and simulators for Workspace on behalf of this process.
 * The process owns what it starts: when it closes, it stops exactly those
 * devices, after its sessions have closed. A device that was already running
 * or booting, or that another process started, is never owned.
 */
export interface OwnedDevicesService {
  readonly bootAndroid: (
    avd: string
  ) => Effect.Effect<string, AndroidBootError>;
  readonly bootIos: (udid: string) => Effect.Effect<IosDevice, IosBootFailure>;
  /**
   * Device Erase (ADR 0081), performed only for a Workspace click. Answering
   * an agent's request records its outcome there.
   */
  readonly erase: (input: {
    readonly platform: DeviceErasePlatform;
    readonly device: string;
    readonly requestId?: string;
  }) => Effect.Effect<void, DeviceEraseFailure>;
  /**
   * Records an agent's request for a Device Erase, or returns the request
   * already made under `operationId`. It never erases anything.
   */
  readonly requestErase: (input: {
    readonly platform: DeviceErasePlatform;
    readonly device: string;
    readonly operationId: string;
  }) => Effect.Effect<DeviceEraseRequest>;
  readonly dismissErase: (id: string) => Effect.Effect<void>;
  /**
   * Reserves a device for a session until the returned release runs. A
   * session holds it from acquisition until its cleanup has finished, and
   * Device Erase holds it for the whole erase, so neither can take a device
   * the other is using.
   */
  readonly reserveDevice: (input: {
    readonly platform: DeviceErasePlatform;
    readonly device: string;
    readonly holder: string;
  }) => Effect.Effect<Effect.Effect<void>, DeviceEraseFailure>;
  readonly eraseState: Effect.Effect<DeviceEraseState>;
}

export const OwnedDevices = Context.Service<OwnedDevicesService>(
  "@contingency/OwnedDevices"
);

/** One stderr line per device, so stdio MCP's stdout stays protocol-only. */
export const describeOutcome = ({
  device,
  platform,
  retained,
}: OwnedDeviceOutcome) => {
  const kind = platform === "android" ? "emulator" : "simulator";
  return retained === undefined
    ? `Stopped the ${kind} ${device} that Contingency started.`
    : `Left the ${kind} ${device} running: ${retained}`;
};

export interface OwnedDevicesOptions {
  readonly android?: ReturnType<typeof makeAndroidDeviceBoot>;
  readonly ios?: ReturnType<typeof makeIosDeviceBoot>;
  readonly report?: (line: string) => Effect.Effect<void>;
}

/**
 * Process-scoped. Provide it outside every layer that holds sessions, so its
 * finalizer runs after they have released their device connections.
 */
export const makeOwnedDevicesLayer = ({
  android = makeAndroidDeviceBoot(),
  ios = makeIosDeviceBoot(),
  report = (line) => Effect.sync(() => process.stderr.write(`${line}\n`)),
}: OwnedDevicesOptions = {}) =>
  Layer.effect(
    OwnedDevices,
    Effect.gen(function* ownDevices() {
      yield* Effect.addFinalizer(() =>
        Effect.all([android.stopOwned, ios.stopOwned], {
          concurrency: "unbounded",
        }).pipe(
          Effect.flatMap((outcomes) =>
            Effect.forEach(outcomes.flat(), (outcome) =>
              report(describeOutcome(outcome))
            )
          ),
          Effect.asVoid
        )
      );
      const requests = new Map<string, DeviceEraseRequest>();
      // The holder of each reserved device: a session id, or ERASING.
      const reserved = new Map<string, string>();
      const ERASING = "erase";
      const reserve: OwnedDevicesService["reserveDevice"] = ({
        device,
        holder,
        platform,
      }) =>
        // Checked and claimed in one step, so two claims cannot interleave.
        Effect.suspend(() => {
          const key = `${platform}:${device}`;
          const current = reserved.get(key);
          if (current !== undefined) {
            return Effect.fail<DeviceEraseFailure>(
              current === ERASING
                ? {
                    code: "device_erasing",
                    message:
                      "This device is being erased. Start the session once it is running again.",
                  }
                : {
                    code: "device_in_use",
                    message: `Session ${current} is using this device. Close it before erasing the device.`,
                  }
            );
          }
          reserved.set(key, holder);
          return Effect.succeed(
            Effect.sync(() => {
              if (reserved.get(key) === holder) {
                reserved.delete(key);
              }
            })
          );
        });
      const settle = (
        id: string | undefined,
        status: DeviceEraseRequest["status"],
        message?: string
      ) =>
        Effect.sync(() => {
          const request = id === undefined ? undefined : requests.get(id);
          if (request?.status !== "pending") {
            return;
          }
          const settled: DeviceEraseRequest =
            message === undefined
              ? { ...request, status }
              : { ...request, message, status };
          requests.set(request.id, settled);
        });
      const eraseDevice = (platform: DeviceErasePlatform, device: string) =>
        platform === "android"
          ? android.erase(device).pipe(Effect.asVoid)
          : ios.erase(device).pipe(
              Effect.asVoid,
              Effect.mapError((failure): DeviceEraseFailure => ({
                code: failure.code,
                message: failure.message,
              }))
            );
      const erase: OwnedDevicesService["erase"] = ({
        device,
        platform,
        requestId,
      }) =>
        Effect.acquireUseRelease(
          reserve({ device, holder: ERASING, platform }),
          () => eraseDevice(platform, device),
          (release) => release
        ).pipe(
          Effect.tapError((failure) =>
            settle(requestId, "failed", failure.message)
          ),
          Effect.tap(() => settle(requestId, "erased"))
        );
      return {
        bootAndroid: android.boot,
        bootIos: ios.boot,
        dismissErase: (id) =>
          settle(id, "dismissed", "The user dismissed the request."),
        erase,
        eraseState: Effect.gen(function* readEraseState() {
          return {
            owned: { android: android.ownedAvds(), ios: yield* ios.ownedUdids },
            requests: [...requests.values()],
          };
        }),
        requestErase: ({ device, operationId, platform }) =>
          Effect.sync(() => {
            const existing = requests.get(operationId);
            if (existing !== undefined) {
              return existing;
            }
            const request: DeviceEraseRequest = {
              device,
              id: OperationId.make(operationId),
              platform,
              requestedAt: new Date().toISOString(),
              status: "pending",
            };
            requests.set(operationId, request);
            return request;
          }),
        reserveDevice: reserve,
      };
    })
  );

export const OwnedDevicesLive = makeOwnedDevicesLayer();
