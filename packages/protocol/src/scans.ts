import { Schema } from "effect";

const text = Schema.String.check(Schema.isMinLength(1));
export const ScanMode = Schema.Literals([
  "accessibility",
  "reload",
  "navigation",
  "timespan",
]);
export type ScanMode = typeof ScanMode.Type;

/** Explicit authoring intent; the learning agent supplies reviewed journey conditions. */
export const TeachingScan = Schema.Struct({
  id: text,
  mode: ScanMode,
  phase: Schema.Literals(["start", "stop"]),
});
export type TeachingScan = typeof TeachingScan.Type;

export const ScanRequirement = Schema.Struct({
  endWhen: Schema.optionalKey(text),
  expectedUrl: Schema.optionalKey(text),
  id: text,
  mode: ScanMode,
  when: text,
});
export type ScanRequirement = typeof ScanRequirement.Type;
export const ScanReference = Schema.Struct({
  ...ScanRequirement.fields,
  flowSkillName: text,
  outsideScope: Schema.optionalKey(text),
});
export type ScanReference = typeof ScanReference.Type;

export const ScanReport = Schema.Struct({
  durationMs: Schema.optionalKey(Schema.Number),
  endedAt: Schema.optionalKey(text),
  flowSkillName: text,
  id: text,
  mode: ScanMode,
  reportPath: Schema.optionalKey(text),
  requirementId: text,
  startedAt: text,
  status: Schema.Literals(["running", "completed", "failed", "partial"]),
  summary: text,
  tabId: text,
  url: text,
});
export type ScanReport = typeof ScanReport.Type;

export const scanRequirementsField = Schema.optionalKey(
  Schema.Array(ScanReference)
);
export const scanReportsField = Schema.optionalKey(Schema.Array(ScanReport));

/** Coverage is established by engine-produced reports, independently of journey findings. */
export const scanCoverage = (run: {
  readonly scanRequirements?: readonly ScanReference[];
  readonly scanReports?: readonly ScanReport[];
}) => {
  const applicable = (run.scanRequirements ?? []).filter(
    (scan) => scan.outsideScope === undefined
  );
  const fulfilled = applicable.filter((scan) =>
    (run.scanReports ?? []).some(
      (report) =>
        report.flowSkillName === scan.flowSkillName &&
        report.requirementId === scan.id &&
        report.status === "completed"
    )
  ).length;
  return {
    complete: fulfilled === applicable.length,
    fulfilled,
    total: applicable.length,
  };
};

export const openTeachingTimespan = (
  instructions: readonly { readonly scan?: TeachingScan | undefined }[]
) => {
  let open: TeachingScan | undefined;
  for (const { scan } of instructions) {
    if (scan?.mode !== "timespan") {
      continue;
    }
    if (scan.phase === "start") {
      open = scan;
    } else if (open?.id === scan.id) {
      open = undefined;
    }
  }
  return open;
};
