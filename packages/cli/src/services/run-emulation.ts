import { DraftEmulation } from "@contingency/protocol";
import { Effect, Schema } from "effect";

import type { FlowSkillPackage } from "./flow-skill-catalog.ts";

type SkillEnvironment = Pick<FlowSkillPackage, "name" | "emulation">;

const invalid = (message: string) => ({
  code: "flow_skill_invalid" as const,
  message,
});
const definedFields = <Value extends object>(fields: Value) =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );

export const defaultRunEmulation: DraftEmulation = {
  permissions: [],
  userAgentProfile: "default",
  viewport: { deviceScaleFactor: 1, height: 800, width: 1280 },
};

/** Decode the saved requirement without dropping invalid fields or inventing a device. */
export const skillRunEmulation = (skill: SkillEnvironment) =>
  Effect.gen(function* readSkillEnvironment() {
    const saved = skill.emulation;
    if (saved === undefined) {
      return;
    }
    if ((saved.diagnostics?.length ?? 0) > 0 || saved.viewport === undefined) {
      return yield* Effect.fail(
        invalid(
          `Flow Skill ${skill.name} has invalid emulation: ${saved.diagnostics?.join(" ") || "A declared environment requires a viewport."} Repair its saved emulation before starting a Run.`
        )
      );
    }
    const emulation = yield* Schema.decodeUnknownEffect(DraftEmulation)(
      definedFields({
        colorScheme: saved.colorScheme,
        geolocation:
          saved.geolocation === undefined
            ? undefined
            : definedFields({ ...saved.geolocation }),
        locale: saved.locale,
        permissions: saved.permissions.map((decision) =>
          definedFields({ ...decision })
        ),
        timezoneId: saved.timezone,
        userAgentProfile: saved.userAgentProfile ?? "default",
        viewport: saved.viewport,
      })
    ).pipe(
      Effect.mapError((cause) =>
        invalid(
          `Flow Skill ${skill.name} has invalid emulation: ${cause.message}`
        )
      )
    );
    yield* Effect.try({
      catch: (cause) =>
        invalid(
          `Flow Skill ${skill.name} has invalid emulation: ${String(cause)}`
        ),
      try: () => {
        if (emulation.locale) {
          Intl.getCanonicalLocales(emulation.locale);
        }
        // Validation needs the supplied zone; a cached default formatter cannot validate it.
        if (emulation.timezoneId) {
          // oxlint-disable-next-line react-doctor/js-hoist-intl
          new Intl.DateTimeFormat("en-US", {
            timeZone: emulation.timezoneId,
          }).resolvedOptions();
        }
        for (const permission of emulation.permissions) {
          if (
            permission.origin &&
            new URL(permission.origin).origin !== permission.origin
          ) {
            throw new Error(
              "Permission origins must be canonical http or https origins."
            );
          }
          if (permission.origin && !/^https?:\/\//u.test(permission.origin)) {
            throw new Error("Permission origins must use http or https.");
          }
        }
      },
    });
    return emulation;
  });

const canonicalPermissions = (emulation: DraftEmulation) =>
  emulation.permissions
    .map((decision) =>
      JSON.stringify([
        decision.permission,
        decision.state,
        decision.origin ?? null,
      ])
    )
    .toSorted();

const sameViewport = Schema.toEquivalence(DraftEmulation.fields.viewport);
const sameGeolocation = Schema.toEquivalence(DraftEmulation.fields.geolocation);

export const emulationDifferences = (
  current: DraftEmulation,
  expected: DraftEmulation
): string[] => {
  const fields = [
    "colorScheme",
    "locale",
    "timezoneId",
    "userAgentProfile",
  ] as const;
  const differences: string[] = fields.filter(
    (field) =>
      JSON.stringify(current[field] ?? null) !==
      JSON.stringify(expected[field] ?? null)
  );
  if (!sameViewport(current.viewport, expected.viewport)) {
    differences.push("viewport");
  }
  if (!sameGeolocation(current.geolocation, expected.geolocation)) {
    differences.push("geolocation");
  }
  if (
    JSON.stringify(canonicalPermissions(current)) !==
    JSON.stringify(canonicalPermissions(expected))
  ) {
    differences.push("permissions");
  }
  return differences;
};

export const startingRunEmulation = (skills: readonly SkillEnvironment[]) =>
  Effect.gen(function* chooseStartingEnvironment() {
    let emulation = defaultRunEmulation;
    let source: FlowSkillPackage["name"] | undefined;
    for (const skill of skills) {
      const expected = yield* skillRunEmulation(skill);
      if (expected === undefined) {
        continue;
      }
      if (source === undefined) {
        emulation = expected;
        source = skill.name;
      } else {
        const fields = emulationDifferences(emulation, expected);
        if (fields.length > 0) {
          return yield* Effect.fail(
            invalid(
              `Flow Skills ${source} and ${skill.name} require different emulation (${fields.join(", ")}). Start separate Runs or align the saved environments; no browser was opened.`
            )
          );
        }
      }
    }
    return { emulation, source };
  });
