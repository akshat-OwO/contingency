import type { IosEnvironment } from "./ios-contract.ts";
import {
  compareNativeAppEnvironments,
  nativeAppEnvironmentPermission,
} from "./native-app-environment.ts";

export const compareIosEnvironments = (
  taught: IosEnvironment,
  selected: IosEnvironment
) =>
  compareNativeAppEnvironments({
    display: (field, value) =>
      field === "permissions"
        ? JSON.stringify(value ?? [])
        : String(value ?? "missing"),
    fields: [
      "deviceType",
      "runtimeVersion",
      "bundleId",
      "build",
      "permissions",
    ],
    selected,
    taught,
  });
export const iosEnvironmentPermission = (
  runId: string,
  taught: IosEnvironment,
  selected: IosEnvironment
) =>
  nativeAppEnvironmentPermission({
    differences: compareIosEnvironments(taught, selected),
    requiresPermission: ({ field }) => field !== "deviceType",
    runId,
    targetApp: selected.bundleId,
  });
