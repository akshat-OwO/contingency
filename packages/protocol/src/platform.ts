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
      startingState: Schema.String.check(Schema.isMinLength(1)),
    }),
    platform: Schema.Literal("android"),
  }),
]);
export type PlatformRequirements = typeof PlatformRequirements.Type;
