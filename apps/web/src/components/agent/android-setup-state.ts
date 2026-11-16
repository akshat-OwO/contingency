import {
  androidSupportedApi,
  isAndroidSupportedApi,
} from "@contingency/protocol";
import type {
  AndroidDiscoveredApp,
  AndroidDiscoveredDevice,
  AndroidWorkspaceSelection,
  StartingData,
} from "@contingency/protocol";

import type { DeviceChoice } from "./device-choice-state";
import { clearDataWarning } from "./native-starting-data-copy";

/** A device the runtime can open a session on, as a selection. */
export const selectable = (
  device: AndroidDiscoveredDevice
): AndroidWorkspaceSelection["device"] | null => {
  const { api, fingerprint } = device;
  if (
    device.state !== "device" ||
    !isAndroidSupportedApi(api) ||
    fingerprint === null ||
    device.release === null
  ) {
    return null;
  }
  if (device.kind === "physical") {
    return null;
  }
  return device.avd === null
    ? null
    : {
        api,
        avd: device.avd,
        fingerprint,
        host: "local",
        serial: device.serial,
      };
};

/** The release a selectable device reports; Preparation rechecks it. */
export const deviceRelease = (device: AndroidDiscoveredDevice | undefined) =>
  device?.release ?? "";

/** Why a reported device cannot be picked, or nothing when it can. */
export const unavailableReason = (device: AndroidDiscoveredDevice) => {
  if (device.kind === "physical") {
    return "physical_device_unsupported: Select an Android emulator";
  }
  if (device.state === "stopped") {
    return "Stopped";
  }
  if (device.state === "unauthorized") {
    return "Allow USB debugging on the device";
  }
  if (device.state !== "device") {
    return device.state === "offline" ? "Offline" : "Unavailable";
  }
  if (!isAndroidSupportedApi(device.api)) {
    return `API ${device.api ?? "unknown"}; needs API ${androidSupportedApi.minimum}–${androidSupportedApi.maximum}`;
  }
  return selectable(device) === null ? "Identity unreadable" : null;
};

/** A reported device as the shared device card shows it. */
export const androidDeviceChoice = (
  device: AndroidDiscoveredDevice
): DeviceChoice => {
  const reason = unavailableReason(device);
  const base = {
    detail: `${device.serial} · API ${device.api}`,
    // An emulator is erased by its AVD; a phone is never erased.
    eraseId:
      device.kind === "emulator" && device.avd !== null
        ? device.avd
        : undefined,
    id: device.serial,
    kind:
      device.kind === "physical" ? ("Phone" as const) : ("Emulator" as const),
    name:
      device.kind === "physical"
        ? (device.model ?? device.serial)
        : (device.avd ?? device.serial),
  };
  if (
    device.kind === "emulator" &&
    device.state === "stopped" &&
    device.avd !== null
  ) {
    return {
      ...base,
      bootId: device.avd,
      detail: "Android emulator",
      status: { _tag: "stopped" },
    };
  }
  return {
    ...base,
    status:
      reason === null ? { _tag: "ready" } : { _tag: "unavailable", reason },
  };
};

const permissionLine =
  /^(?<decision>grant|revoke)\s+(?<permission>android\.permission\.[A-Z_]+)$/u;
export const parseAndroidPermissionDecisions = (
  text: string
):
  | NonNullable<AndroidWorkspaceSelection["environment"]["permissions"]>
  | undefined => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = lines.flatMap((line) => {
    const groups = permissionLine.exec(line)?.groups;
    const permission = groups?.permission;
    const decision = groups?.decision;
    return permission && (decision === "grant" || decision === "revoke")
      ? [
          { decision, permission } satisfies NonNullable<
            AndroidWorkspaceSelection["environment"]["permissions"]
          >[number],
        ]
      : [];
  });
  return entries.length === lines.length &&
    new Set(entries.map((entry) => entry.permission)).size === entries.length
    ? entries
    : undefined;
};

/** A role and accessible name that gate the start or prove the finish. */
export interface AndroidCondition {
  readonly name: string;
  readonly role: string;
}

/**
 * The device the start card sets up: the one the person picked, or, with
 * exactly one ready device, that one, since there is nothing to choose.
 */
export const chosenSerial = (
  listed: readonly AndroidDiscoveredDevice[],
  picked: string | null
): string | null => {
  if (picked !== null) {
    return picked;
  }
  const ready = listed.filter((entry) => unavailableReason(entry) === null);
  return ready.length === 1 ? (ready[0]?.serial ?? null) : null;
};

/** The Android selection the start card's choices declare. */
export const setupSelection = ({
  app,
  device,
  outcome,
  permissions,
  privateInput,
  release,
  start,
  startingData,
}: {
  readonly app: AndroidDiscoveredApp;
  readonly device: AndroidWorkspaceSelection["device"];
  readonly outcome: AndroidCondition;
  readonly permissions: NonNullable<
    AndroidWorkspaceSelection["environment"]["permissions"]
  >;
  readonly privateInput: boolean;
  readonly release: string;
  readonly start: AndroidCondition;
  readonly startingData: StartingData;
}): AndroidWorkspaceSelection => ({
  device,
  environment: {
    androidVersion: release,
    appBuild: app.versionCode,
    appId: app.package,
    permissions,
    startingState:
      start.name === ""
        ? "Restart the Target App"
        : `${start.role} ${start.name} is visible`,
  },
  helperConsent: "auto",
  outcomes: outcome.name === "" ? [] : [outcome],
  privateInput,
  setup: {
    activity: app.launchActivity,
    conditions: start.name === "" ? [] : [start],
    kind: "restart-activity",
    startingData,
  },
});

/** What the start card still needs, said once under the disabled start. */
export const setupMissing = ({
  app,
  device,
  validName,
}: {
  readonly app: unknown;
  readonly device: unknown;
  readonly validName: boolean;
}): string => {
  if (!validName) {
    return "Name the Flow to continue.";
  }
  if (device === null) {
    return "Choose a running device to continue.";
  }
  if (app === undefined) {
    return "Choose the Target App to continue.";
  }
  return "Finish the setup above to continue.";
};

/** What confirming preparation does to the app and its data. */
export const preparationDescription = (
  apk: string | undefined,
  startingData: StartingData,
  app: string
) => {
  if (startingData === "clear") {
    return `${apk === undefined ? "Use the installed Target App without reinstalling it." : "Reinstall the selected APK."} ${clearDataWarning(app)}`;
  }
  return apk === undefined
    ? "Use the installed Target App without reinstalling it."
    : "Reinstall the selected APK while preserving existing app data and login state.";
};
