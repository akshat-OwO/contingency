import { isAndroidSupportedApi } from "@contingency/protocol";
import { Effect } from "effect";

import { androidCapabilities } from "./android-runtime-contract.ts";
import type { AndroidRuntimeStartInput } from "./android-runtime-contract.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";

const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const serialPattern = /^[A-Za-z0-9._:-]+$/u;
const availableCapabilities = new Set(androidCapabilities);

export const validateAndroidStartup = (input: AndroidRuntimeStartInput) =>
  Effect.gen(function* validateStartup() {
    if (input.device.kind === "physical") {
      return yield* Effect.fail(
        platformRuntimeError("physical_device_unsupported")
      );
    }
    if (
      input.device.host !== "local" ||
      !serialPattern.test(input.device.serial) ||
      !packagePattern.test(input.targetApp) ||
      !input.device.avd ||
      !input.device.fingerprint
    ) {
      return yield* Effect.fail(
        platformRuntimeError("device_selection_required")
      );
    }
    if (!isAndroidSupportedApi(input.device.api)) {
      return yield* Effect.fail(platformRuntimeError("api_unsupported"));
    }
    if (
      input.requiredCapabilities.some(
        (capability) => !availableCapabilities.has(capability)
      )
    ) {
      return yield* Effect.fail(platformRuntimeError("capability_missing"));
    }
  });
