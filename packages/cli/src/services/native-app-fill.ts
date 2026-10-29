import { isAgentDeviceError } from "agent-device";
import { Effect } from "effect";

import { platformRuntimeError } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const fillIo = <A>(
  operation: (signal: AbortSignal) => Promise<A>,
  runtimeError: (code: "runtime_failed") => PlatformRuntimeError
) =>
  Effect.tryPromise({
    catch: (cause): PlatformRuntimeError => {
      const error = {
        ...runtimeError("runtime_failed"),
        operation: "fill" as const,
      };
      if (isAgentDeviceError(cause)) {
        const reason = cause.details?.reason;
        if (
          reason === "ref_generation_mismatch" ||
          reason === "stale_ref" ||
          reason === "device_not_found" ||
          reason === "request_canceled" ||
          reason === "android_text_input_unverified" ||
          reason === "input_unverified"
        ) {
          return { ...error, backendReason: reason };
        }
      }
      return error;
    },
    try: operation,
  });

/** SDK readback failures acknowledge entry without making the journey fail. */
export const performNativeAppFill = (
  operation: (
    signal: AbortSignal
  ) => Promise<{ readonly verification?: "unconfirmed" }>,
  runtimeError: (
    code: "runtime_failed"
  ) => PlatformRuntimeError = platformRuntimeError
) =>
  fillIo(operation, runtimeError).pipe(
    Effect.map((result) => ({
      confirmation:
        result.verification === "unconfirmed"
          ? ("unconfirmed" as const)
          : ("confirmed" as const),
      outcome: "entered" as const,
    })),
    Effect.catchIf(
      (error) =>
        error.backendReason === "android_text_input_unverified" ||
        error.backendReason === "input_unverified",
      () =>
        Effect.succeed({
          confirmation: "unconfirmed" as const,
          outcome: "entered" as const,
        })
    )
  );
