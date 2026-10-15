import { PlatformRequirements } from "@contingency/protocol";
import type {
  PlatformCapability,
  PlatformIdentity,
} from "@contingency/protocol";
import { Effect, Result, Schema } from "effect";

export const browserCapabilities: readonly PlatformCapability[] = [
  "semantic-actions",
  "coordinate-actions",
  "screenshots",
  "private-input",
  "teaching-capture",
  "navigation-policy",
  "emulation",
];

/** Packages written before runtime stamping are browser packages, including phone Emulation. */
export const browserRequirements: PlatformRequirements = {
  capabilities: [
    "semantic-actions",
    "screenshots",
    "private-input",
    "navigation-policy",
    "emulation",
  ],
  environment: { engine: "chromium" },
  platform: "web",
};

export interface SavedPlatformRequirements {
  readonly diagnostics: readonly string[];
  readonly requirements: PlatformRequirements;
}

/** A single JSON scalar keeps the existing restricted frontmatter grammar unambiguous. */
export const readPlatformRequirements = (
  values: readonly string[]
): SavedPlatformRequirements => {
  if (values.length === 0) {
    return { diagnostics: [], requirements: browserRequirements };
  }
  if (values.length !== 1) {
    return {
      diagnostics: ["Declare runtime exactly once."],
      requirements: browserRequirements,
    };
  }
  const parsed = Result.try(() => {
    const json: unknown = JSON.parse(values[0] ?? "");
    return Schema.decodeUnknownResult(PlatformRequirements, {
      onExcessProperty: "error",
    })(json);
  });
  if (Result.isFailure(parsed)) {
    return {
      diagnostics: ["runtime must be a JSON object on one line."],
      requirements: browserRequirements,
    };
  }
  const decoded = parsed.success;
  return Result.isFailure(decoded)
    ? {
        diagnostics: [
          `Invalid runtime requirements: ${decoded.failure.message}`,
        ],
        requirements: browserRequirements,
      }
    : { diagnostics: [], requirements: decoded.success };
};

export const validatePlatformRequirements = (
  saved: SavedPlatformRequirements,
  platform: PlatformIdentity,
  capabilities: readonly PlatformCapability[]
) =>
  Effect.gen(function* validateRequirements() {
    const { requirements, diagnostics } = saved;
    if (diagnostics.length > 0) {
      return yield* Effect.fail({
        code: "flow_skill_invalid" as const,
        message: diagnostics.join(" "),
      });
    }
    if (requirements.platform !== platform) {
      return yield* Effect.fail({
        code: "flow_skill_invalid" as const,
        message: `This runtime supports ${platform}, but the Flow Skill requires ${requirements.platform}. Select a supported ${requirements.platform} runtime and verify that platform separately.`,
      });
    }
    const available = new Set(capabilities);
    const missing = requirements.capabilities.filter(
      (capability) => !available.has(capability)
    );
    if (missing.length > 0) {
      return yield* Effect.fail({
        code: "flow_skill_invalid" as const,
        message: `The ${platform} runtime is missing required capabilities: ${missing.join(", ")}. Use a runtime that supports them.`,
      });
    }
  });
