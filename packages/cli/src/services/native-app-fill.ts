import { isAgentDeviceError } from "agent-device";
import { Effect } from "effect";

import { platformRuntimeError, tryBackend } from "./platform-runtime-error.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

/**
 * A fill the SDK refused. One its reason explains is retried or reported by
 * that reason; any other names its cause by Failure Reference.
 */
const fillIo = <A>(
  operation: (signal: AbortSignal) => Promise<A>,
  runtimeError: (code: "runtime_failed") => PlatformRuntimeError
) =>
  tryBackend(operation, (cause): PlatformRuntimeError => {
    const error = {
      ...runtimeError("runtime_failed"),
      operation: "fill" as const,
    };
    if (!isAgentDeviceError(cause)) {
      return error;
    }
    // The iOS runner typed the text, but the field read back otherwise.
    if (
      cause.code === "TEXT_ENTRY_MISMATCH" ||
      cause.details?.runnerErrorCode === "TEXT_ENTRY_MISMATCH"
    ) {
      return { ...error, backendReason: "text_entry_mismatch" };
    }
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
    return error;
  });

/**
 * SDK readback failures acknowledge entry without making the journey fail.
 * A read-back that differs from the text, such as dropped characters or the
 * app's own formatting, is one too: the agent checks the field and fills it
 * again from a fresh observation.
 */
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
        error.backendReason === "input_unverified" ||
        error.backendReason === "text_entry_mismatch",
      (error) =>
        Effect.logDebug("Fill entered without a matching read-back").pipe(
          Effect.annotateLogs({ backendReason: error.backendReason }),
          Effect.as({
            confirmation: "unconfirmed" as const,
            outcome: "entered" as const,
          })
        )
    )
  );
