import { Effect, Schema } from "effect";

import { iosCommand } from "./ios-simctl.ts";
import type { PlatformRuntimeError } from "./platform-runtime.ts";

const unknown = (): PlatformRuntimeError => ({
  _tag: "PlatformRuntimeError",
  code: "ownership_unknown",
  message: "The Target App's foreground ownership could not be established.",
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
        Schema.fromJsonString(Foreground)
      )(yield* query(udid));
      if (result.udid !== udid || result.owner.bundleId !== targetApp) {
        return yield* Effect.fail(unknown());
      }
    }).pipe(
      Effect.mapError(unknown),
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(unknown()),
      })
    ),
});
