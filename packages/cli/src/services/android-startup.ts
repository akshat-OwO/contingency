import { Effect } from "effect";

import { androidCapabilities } from "./android-runtime-contract.ts";
import type { AndroidRuntimeStartInput } from "./android-runtime-contract.ts";
import { platformRuntimeError } from "./platform-runtime-error.ts";

const availableCapabilities = new Set(androidCapabilities);

export const validateAndroidStartup = (input: AndroidRuntimeStartInput) =>
  Effect.gen(function* validateStartup() {
    if (
      input.device.host !== "local" ||
      !input.device.serial ||
      !input.device.avd ||
      !input.device.fingerprint ||
      input.device.api !== 36
    ) {
      return yield* Effect.fail(
        platformRuntimeError("device_selection_required")
      );
    }
    if (
      input.requiredCapabilities.some(
        (capability) => !availableCapabilities.has(capability)
      )
    ) {
      return yield* Effect.fail(platformRuntimeError("capability_missing"));
    }
  });
