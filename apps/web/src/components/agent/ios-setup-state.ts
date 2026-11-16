import type {
  IosDeviceSelection,
  IosInstalledApp,
  IosWorkspaceSelection,
  StartingData,
  UploadedIosApp,
} from "@contingency/protocol";

import type { DeviceChoice } from "./device-choice-state";
import type { NativeCondition } from "./native-condition";

/** A simulator as discovery reports it, with its `simctl` state. */
export interface IosListedDevice {
  readonly name: string;
  readonly runtimeVersion: string;
  readonly state: string;
  readonly udid: string;
}

/**
 * A matrix simulator as the shared device card shows it. A shut-down or
 * booting simulator can be started; starting one that is already booting
 * waits for it.
 */
export const iosDeviceChoice = (device: IosListedDevice): DeviceChoice => {
  const base = {
    detail: `iOS ${device.runtimeVersion}`,
    eraseId: device.udid,
    id: device.udid,
    kind: "Simulator" as const,
    name: device.name,
  };
  if (device.state === "Booted") {
    return { ...base, status: { _tag: "ready" } };
  }
  if (device.state === "Shutdown" || device.state === "Booting") {
    return { ...base, bootId: device.udid, status: { _tag: "stopped" } };
  }
  return { ...base, status: { _tag: "unavailable", reason: device.state } };
};

/**
 * What the start card's Device Erase ownership read is keyed on. Any change to
 * the simulators or their states, such as finishing a Start, reads which of
 * them this process owns again.
 */
export const simulatorInventoryKey = (listed: readonly IosListedDevice[]) =>
  listed.map((device) => `${device.udid}:${device.state}`).join(",");

/**
 * The simulator the start card sets up: the one the person picked while it is
 * still booted, or, with exactly one booted simulator, that one.
 */
export const chosenSimulator = (
  listed: readonly IosListedDevice[],
  picked: string | null
): string | null => {
  const booted = listed.filter((device) => device.state === "Booted");
  if (picked !== null && booted.some((device) => device.udid === picked)) {
    return picked;
  }
  return booted.length === 1 ? (booted[0]?.udid ?? null) : null;
};

/** The Target App: an uploaded simulator build, or an installed app. */
export type IosTarget =
  | { readonly _tag: "installed"; readonly app: IosInstalledApp }
  | { readonly _tag: "uploaded"; readonly upload: UploadedIosApp };

/**
 * The iOS selection the start card's choices declare. An uploaded build
 * carries its temporary copy, which the started session then owns.
 */
export const iosSetupSelection = ({
  device,
  outcome,
  start,
  startingData,
  target,
}: {
  readonly device: IosDeviceSelection;
  readonly outcome: NativeCondition;
  readonly start: NativeCondition;
  readonly startingData: StartingData;
  readonly target: IosTarget;
}): IosWorkspaceSelection => {
  const { build, bundleId } =
    target._tag === "installed" ? target.app : target.upload;
  const selection: IosWorkspaceSelection = {
    device,
    environment: {
      build,
      bundleId,
      deviceType: device.deviceType,
      runtimeVersion: device.runtimeVersion,
    },
    outcomes: outcome.name === "" ? [] : [outcome],
    setup: {
      conditions: start.name === "" ? [] : [start],
      kind: "restart-app",
      startingData,
    },
  };
  return target._tag === "uploaded"
    ? { ...selection, appPath: target.upload.appPath }
    : selection;
};

/** What the start card still needs, said once under the disabled start. */
export const iosSetupMissing = ({
  booted,
  device,
  target,
  validName,
}: {
  /** Whether any simulator is running. */
  readonly booted: boolean;
  readonly device: unknown;
  readonly target: unknown;
  readonly validName: boolean;
}): string => {
  if (!validName) {
    return "Name the Flow to continue.";
  }
  if (!booted) {
    return "Start a simulator to continue.";
  }
  if (device === null) {
    return "Choose a running simulator to continue.";
  }
  if (target === null) {
    return "Choose the Target App to continue.";
  }
  return "Finish the setup above to continue.";
};
