import type { DeviceChoice } from "./device-choice-state";

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
 * What the sheet's Device Erase ownership read is keyed on. Any change to
 * the simulators or their states, such as finishing a Start, reads which of
 * them this process owns again.
 */
export const simulatorInventoryKey = (listed: readonly IosListedDevice[]) =>
  listed.map((device) => `${device.udid}:${device.state}`).join(",");

/**
 * The simulator the sheet sets up: the one the person picked while it is
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
