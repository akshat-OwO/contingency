import { Effect, Schema } from "effect";

import { iosOwnershipError, logIosOwnershipError } from "./ios-ownership.ts";
import { iosCommand } from "./ios-simctl.ts";

const Refusal = Schema.Struct({
  reason: Schema.Literals([
    "ax_query_failed",
    "ax_query_timeout",
    "ax_no_primary_app",
    "ax_device_missing",
    "ax_automation_unavailable",
    "ax_pid_changed",
    "ax_bundle_changed",
  ]),
  version: Schema.Literal(1),
});

const Foreground = Schema.Struct({
  owner: Schema.Struct({
    bundleId: Schema.NonEmptyString,
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  udid: Schema.NonEmptyString,
  version: Schema.Literal(1),
});

/** No cached success: each validation queries the bound Simulator's primary AX owner. */
export const makeIosForegroundAuthority = (
  executable: string,
  query: (udid: string) => Effect.Effect<string, unknown> = (udid) =>
    iosCommand("xcrun", ["simctl", "spawn", udid, executable])
) => ({
  validate: (udid: string, targetApp: string) =>
    Effect.gen(function* validateForeground() {
      const result = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Union([Foreground, Refusal]))
      )(
        yield* query(udid).pipe(
          Effect.mapError(() => iosOwnershipError("helper_transport"))
        )
      ).pipe(Effect.mapError(() => iosOwnershipError("helper_reply_invalid")));
      if ("reason" in result) {
        return yield* Effect.fail(iosOwnershipError(result.reason));
      }
      if (result.udid !== udid) {
        return yield* Effect.fail(iosOwnershipError("device_mismatch"));
      }
      if (result.owner.bundleId !== targetApp) {
        return yield* Effect.fail(iosOwnershipError("bundle_mismatch"));
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(iosOwnershipError("helper_timeout")),
      }),
      Effect.tapError(logIosOwnershipError)
    ),
});
