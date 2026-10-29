import { Schema, SchemaGetter } from "effect";

export const PlatformIdentity = Schema.Literals(["web", "android", "ios"]);
export type PlatformIdentity = typeof PlatformIdentity.Type;

export const PlatformCapability = Schema.Literals([
  "semantic-actions",
  "coordinate-actions",
  "screenshots",
  "private-input",
  "teaching-capture",
  "navigation-policy",
  "emulation",
]);
export type PlatformCapability = typeof PlatformCapability.Type;

export const AndroidStartingCondition = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  role: Schema.String.check(Schema.isMinLength(1)),
});
export const AndroidPreparation = Schema.Struct({
  activity: Schema.String.check(Schema.isMinLength(1)),
  conditions: Schema.Array(AndroidStartingCondition).check(
    Schema.isMinLength(1)
  ),
  kind: Schema.Literal("restart-activity"),
});
export type AndroidPreparation = typeof AndroidPreparation.Type;

export const IosDeviceSelection = Schema.Struct({
  deviceType: Schema.String.check(
    Schema.isPattern(/^com\.apple\.CoreSimulator\.SimDeviceType\.iPhone-/u)
  ),
  kind: Schema.Literal("simulator"),
  name: Schema.String,
  runtime: Schema.NonEmptyString,
  runtimeVersion: Schema.NonEmptyString,
  udid: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu)
  ),
});
/** A Target App's starting privacy state; preparation refuses services `simctl privacy` lacks. */
export const IosPermissionState = Schema.Struct({
  decision: Schema.Literals(["grant", "revoke", "reset"]),
  service: Schema.String.check(Schema.isPattern(/^[a-z][a-z-]*$/u)),
});
export const IosRunEnvironment = Schema.Struct({
  build: Schema.NonEmptyString,
  bundleId: Schema.NonEmptyString,
  deviceType: Schema.NonEmptyString,
  permissions: Schema.optionalKey(Schema.Array(IosPermissionState)),
  runtimeVersion: Schema.NonEmptyString,
});
export const IosPreparation = Schema.Struct({
  conditions: Schema.Array(AndroidStartingCondition).check(
    Schema.isMinLength(1)
  ),
  kind: Schema.Literal("restart-app"),
});

/** Internal runtime requirements. Browser Emulation remains a separate typed contract. */
export const PlatformRequirements = Schema.Union([
  Schema.Struct({
    capabilities: Schema.Array(PlatformCapability),
    environment: Schema.Struct({ engine: Schema.Literal("chromium") }),
    platform: Schema.Literal("web"),
  }),
  Schema.Struct({
    capabilities: Schema.Array(PlatformCapability),
    environment: Schema.Struct({
      androidVersion: Schema.String.check(Schema.isMinLength(1)),
      appBuild: Schema.String.check(Schema.isMinLength(1)),
      appId: Schema.String.check(Schema.isMinLength(1)),
      permissions: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            decision: Schema.Literals(["grant", "revoke"]),
            permission: Schema.String.check(
              Schema.isPattern(/^android\.permission\.[A-Z_]+$/u)
            ),
          })
        )
      ),
      startingState: Schema.String.check(Schema.isMinLength(1)),
    }),
    outcomes: Schema.optionalKey(Schema.Array(AndroidStartingCondition)),
    platform: Schema.Literal("android"),
    preparation: Schema.optionalKey(AndroidPreparation),
    /** Skills saved before ADR 0067 carry this allowlist; read, then discarded. */
    reversibleActions: Schema.optionalKey(Schema.Unknown).pipe(
      Schema.decodeTo(Schema.optionalKey(Schema.Unknown), {
        decode: SchemaGetter.omit(),
        encode: SchemaGetter.omit(),
      })
    ),
  }),
  Schema.Struct({
    capabilities: Schema.Array(PlatformCapability),
    environment: IosRunEnvironment,
    outcomes: Schema.optionalKey(Schema.Array(AndroidStartingCondition)),
    platform: Schema.Literal("ios"),
    preparation: Schema.optionalKey(IosPreparation),
    /** Legacy taught controls do not limit native Runs. */
    reversibleActions: Schema.optionalKey(Schema.Unknown).pipe(
      Schema.decodeTo(Schema.optionalKey(Schema.Unknown), {
        decode: SchemaGetter.omit(),
        encode: SchemaGetter.omit(),
      })
    ),
  }),
]);
export type PlatformRequirements = typeof PlatformRequirements.Type;
