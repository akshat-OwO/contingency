import type {
  DeviceErasePlatform,
  DeviceEraseRequest,
} from "@contingency/protocol";

import type { DeviceChoice } from "./device-choice-state";

/** One erase's progress, keyed by the device's erase id. */
export type DeviceErasing =
  | { readonly _tag: "erasing" }
  | { readonly _tag: "failed"; readonly reason: string };

/** What a setup sheet's device step needs to offer Device Erase. */
export interface DeviceEraseControls {
  readonly platform: DeviceErasePlatform;
  /** Devices this process started, which it may stop to erase. */
  readonly owned: readonly string[];
  /** Agent requests still waiting on the user, for this platform. */
  readonly requests: readonly DeviceEraseRequest[];
  readonly erasing: Readonly<Record<string, DeviceErasing>>;
  /** Asks the user to confirm erasing a device, then erases it. */
  readonly confirm: (eraseId: string, name: string, requestId?: string) => void;
  readonly dismiss: (requestId: string) => void;
}

/**
 * Whether the device step offers Erase Device for a device: a stopped one,
 * or a running one this process started. A running device anybody else
 * started must be stopped first.
 */
export const erasable = (device: DeviceChoice, controls: DeviceEraseControls) =>
  device.eraseId !== undefined &&
  (device.status._tag === "stopped" ||
    device.status._tag === "failed" ||
    controls.owned.includes(device.eraseId));
