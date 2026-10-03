import { ScanRequirement } from "@contingency/protocol";
import type {
  FlowSkillFile,
  ScanReference,
  TeachingScan,
} from "@contingency/protocol";
import { Effect, Result, Schema } from "effect";

export const SCANS_FILE = "references/scans.json";
const document = Schema.Struct({
  requirements: Schema.Array(ScanRequirement),
  schemaVersion: Schema.Literal(1),
});
const invalid = (message: string) => ({
  code: "flow_skill_invalid" as const,
  message,
});

export const parseScanRequirements = (files: readonly FlowSkillFile[]) => {
  const file = files.find((candidate) => candidate.path === SCANS_FILE);
  if (file === undefined) {
    return Result.succeed<readonly ScanRequirement[]>([]);
  }
  try {
    const { requirements } = Schema.decodeUnknownSync(document)(
      JSON.parse(file.content)
    );
    const skill = files.find((candidate) => candidate.path === "SKILL.md");
    const ids = new Set<string>();
    for (const requirement of requirements) {
      if (ids.has(requirement.id)) {
        return Result.fail(invalid("Scan requirement IDs must be unique."));
      }
      ids.add(requirement.id);
      if (
        requirement.mode === "navigation" &&
        requirement.expectedUrl === undefined
      ) {
        return Result.fail(
          invalid("Navigation scans require the reviewed expectedUrl.")
        );
      }
      if (
        requirement.mode !== "timespan" &&
        requirement.endWhen !== undefined
      ) {
        return Result.fail(
          invalid("Only timespan scans have an endWhen condition.")
        );
      }
      if (requirement.expectedUrl !== undefined) {
        const destination = new URL(requirement.expectedUrl);
        if (
          requirement.mode !== "navigation" ||
          !["http:", "https:"].includes(destination.protocol)
        ) {
          return Result.fail(
            invalid(
              "Only navigation scans accept expectedUrl, which must be an absolute HTTP(S) URL."
            )
          );
        }
      }
      if (
        !skill?.content.includes(SCANS_FILE) ||
        !skill.content.includes(requirement.id)
      ) {
        return Result.fail(
          invalid(
            `Link ${SCANS_FILE} and name scan ${requirement.id} in SKILL.md.`
          )
        );
      }
    }
    return Result.succeed(requirements);
  } catch (error) {
    return Result.fail(invalid(`Invalid ${SCANS_FILE}: ${String(error)}`));
  }
};

export const requestedScans = (
  skills: readonly {
    readonly name: string;
    readonly files: readonly FlowSkillFile[];
  }[],
  ready = true
) =>
  Effect.gen(function* loadScanRequirements() {
    const references: ScanReference[] = [];
    for (const skill of skills) {
      const parsed = parseScanRequirements(skill.files);
      if (Result.isFailure(parsed)) {
        return yield* Effect.fail(parsed.failure);
      }
      for (const requirement of parsed.success) {
        if (
          ready &&
          requirement.mode === "timespan" &&
          requirement.endWhen === undefined
        ) {
          return yield* Effect.fail(
            invalid(
              `Scan ${requirement.id} has no reviewed endWhen. Repair the draft before running.`
            )
          );
        }
        references.push({ ...requirement, flowSkillName: skill.name });
      }
    }
    return references;
  });

/** A learning agent may infer timing, but cannot omit or change an explicit taught mode. */
export const validateTaughtScans = (
  files: readonly FlowSkillFile[],
  events: readonly { readonly scan?: TeachingScan | undefined }[]
) =>
  Effect.gen(function* validateTaughtRequirements() {
    const parsed = parseScanRequirements(files);
    if (Result.isFailure(parsed)) {
      return yield* Effect.fail(parsed.failure);
    }
    const starts = events.flatMap(({ scan }) =>
      scan?.phase === "start" ? [scan] : []
    );
    if (starts.length !== parsed.success.length) {
      return yield* Effect.fail(
        invalid(
          "Preserve every taught scan in references/scans.json; do not invent additional scans."
        )
      );
    }
    const requirements = new Map(parsed.success.map((scan) => [scan.id, scan]));
    const stops = new Set(
      events.flatMap(({ scan }) => (scan?.phase === "stop" ? [scan.id] : []))
    );
    for (const start of starts) {
      const requirement = requirements.get(start.id);
      if (requirement === undefined || requirement.mode !== start.mode) {
        return yield* Effect.fail(
          invalid(
            `Preserve taught scan ${start.id} and its ${start.mode} mode.`
          )
        );
      }
      if (
        start.mode === "timespan" &&
        stops.has(start.id) &&
        requirement.endWhen === undefined
      ) {
        return yield* Effect.fail(
          invalid(
            `Scan ${start.id} needs the taught stop condition in endWhen.`
          )
        );
      }
    }
  });
