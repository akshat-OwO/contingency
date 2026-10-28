import { Schema } from "effect";

export const PlatformIdentity = Schema.Literals(["web", "android"]);
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
  }),
]);
export type PlatformRequirements = typeof PlatformRequirements.Type;
