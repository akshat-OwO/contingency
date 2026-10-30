import { randomUUID } from "node:crypto";

import { androidPermissionDecisionApi } from "@contingency/protocol";
import { Effect } from "effect";

import type {
  AndroidRun,
  AndroidRunDriver,
  AndroidRunDecision,
  AndroidRunInput,
} from "./android-run-contract.ts";
import type { AndroidObservation } from "./android-runtime-contract.ts";
import { validateAndroidStartup } from "./android-startup.ts";
import {
  compareNativeAppEnvironments,
  nativeAppEnvironmentPermission,
} from "./native-app-environment.ts";
import { createNativeAppRun } from "./native-app-run.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const fields = [
  "androidVersion",
  "appBuild",
  "appId",
  "startingState",
  "permissions",
] as const;
const activityPattern = /^[A-Za-z][A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/u;
const permissionPattern = /^android\.permission\.[A-Z_]+$/u;
const hashPattern = /^[a-f0-9]{64}$/u;

const validPermissions = (input: AndroidRunInput) => {
  const permissions = input.environment.permissions ?? [];
  return (
    permissions.every(
      (entry) =>
        permissionPattern.test(entry.permission) &&
        ["grant", "revoke"].includes(entry.decision)
    ) &&
    new Set(permissions.map((entry) => entry.permission)).size ===
      permissions.length
  );
};

export const validateAndroidRun = (input: AndroidRunInput) =>
  Effect.gen(function* validateRun() {
    yield* validateAndroidStartup(input);
    if (
      (input.environment.permissions ?? []).length > 0 &&
      input.device.api < androidPermissionDecisionApi
    ) {
      return yield* Effect.fail(
        platformRuntimeError("permission_decisions_unsupported")
      );
    }
    const required = new Set(input.requiredCapabilities);
    if (
      input.taught.platform !== "android" ||
      input.taught.capabilities.some((capability) => !required.has(capability))
    ) {
      return yield* Effect.fail(platformRuntimeError("capability_missing"));
    }
    if (
      !input.environment.androidVersion ||
      input.environment.appId !== input.targetApp ||
      !input.environment.appBuild ||
      !input.environment.startingState ||
      input.setup.kind !== "restart-activity" ||
      !validPermissions(input) ||
      !activityPattern.test(input.setup.activity) ||
      input.setup.activity.split("/")[0] !== input.targetApp ||
      input.setup.conditions.length === 0 ||
      input.setup.conditions.some(
        (condition) => !condition.role || !condition.name
      ) ||
      (input.appInstallation !== undefined &&
        (!hashPattern.test(input.appInstallation.sha256) ||
          !input.appInstallation.apk))
    ) {
      return yield* Effect.fail(platformRuntimeError("preparation_failed"));
    }
  });

export const createAndroidRun = (
  request: AndroidRunInput,
  driver: AndroidRunDriver
): Effect.Effect<AndroidRun, PlatformRuntimeError> =>
  createNativeAppRun<AndroidRunInput, AndroidObservation, AndroidRunDecision>(
    request,
    {
      ...driver,
      authorize: (input) => input,
      decisions: (input, runId, differences) => [
        ...nativeAppEnvironmentPermission({
          differences,
          requiresPermission: (difference) =>
            difference.field !== "startingState",
          runId,
          targetApp: input.targetApp,
        }),
        ...(input.appInstallation === undefined
          ? []
          : [
              {
                differences: [],
                id: randomUUID(),
                kind: "app-installation" as const,
                runId,
                sha256: input.appInstallation.sha256,
                targetApp: input.targetApp,
              },
            ]),
      ],
      differences: (input) => {
        if (input.taught.platform !== "android") {
          return [];
        }
        const { environment } = input.taught;
        return compareNativeAppEnvironments({
          display: (field, value) =>
            field === "permissions"
              ? JSON.stringify(value ?? [])
              : String(value),
          fields,
          selected: input.environment,
          taught: environment,
        });
      },
      error: platformRuntimeError,
      startingConditions: (input, observation) =>
        input.setup.conditions.every((condition) =>
          observation.nodes.some(
            (node) =>
              node.packageName === input.targetApp &&
              !node.covered &&
              !node.password &&
              node.role === condition.role &&
              node.name === condition.name
          )
        ),
      validate: validateAndroidRun,
    }
  );
