/**
 * A device as either setup sheet shows it. `stopped` is an existing emulator
 * or simulator the sheet can start; `unavailable` says why it cannot be used.
 */
export type DeviceChoiceStatus =
  | { readonly _tag: "ready" }
  | { readonly _tag: "stopped" }
  | { readonly _tag: "starting" }
  | { readonly _tag: "failed"; readonly reason: string }
  | { readonly _tag: "unavailable"; readonly reason: string };

export interface DeviceChoice {
  /** What the sheet selects by: a serial or a UDID. */
  readonly id: string;
  /** What starting it names: an AVD or a UDID. Absent when it cannot start. */
  readonly bootId?: string;
  /**
   * What a Device Erase names: an AVD or a UDID. Absent for a device that
   * cannot be erased, such as a phone.
   */
  readonly eraseId?: string | undefined;
  readonly kind: "Emulator" | "Simulator" | "Phone";
  readonly name: string;
  /** The OS version and identity line shown under a ready device's name. */
  readonly detail: string;
  readonly status: DeviceChoiceStatus;
}

/** A start the sheet asked for, keyed by boot id, until discovery shows it. */
export type DeviceStart =
  | { readonly _tag: "starting" }
  | { readonly _tag: "failed"; readonly reason: string };

/** A stopped device shows its own start's progress or failure. */
export const withStarts = (
  devices: readonly DeviceChoice[],
  starts: Readonly<Record<string, DeviceStart>>
): readonly DeviceChoice[] =>
  devices.map((device) => {
    const start =
      device.bootId === undefined ? undefined : starts[device.bootId];
    return device.status._tag === "stopped" && start !== undefined
      ? { ...device, status: start }
      : device;
  });

export const isStartable = (device: DeviceChoice) =>
  device.bootId !== undefined &&
  (device.status._tag === "stopped" ||
    device.status._tag === "starting" ||
    device.status._tag === "failed");
