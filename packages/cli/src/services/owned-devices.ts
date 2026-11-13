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
      return { bootAndroid: android.boot, bootIos: ios.boot };
    })
  );

export const OwnedDevicesLive = makeOwnedDevicesLayer();
