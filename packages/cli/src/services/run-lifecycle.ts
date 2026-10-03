import { randomUUID } from "node:crypto";
import path from "node:path";

import type {
  AgentRunState,
  TaskAgentRunState,
  TaskAgentRunSummary,
  AgentRunStep,
  AgentRunAssessmentCounts,
  AgentRunCoverage,
  RunVideoTimeMap,
  DraftEmulation,
  AgentSessionSnapshot,
  AgentTimelineEntry,
  AgentTaskAssessment,
  AgentRunTaskInput,
  AgentRunTaskVariable,
  FlowSkillName,
} from "@contingency/protocol";
import { AgentRunSummary, OperationId } from "@contingency/protocol";
import type { FileSystem } from "effect";
import { Effect, Exit, Schema, Scope } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { AgentRunStoreService } from "./agent-run-store.ts";
import { agentSessionError as error } from "./agent-session-error.ts";
import type { AgentSessionError } from "./agent-session-error.ts";
import type { RunFootage, FootageManifest } from "./run-footage.ts";
import { planRunVideo } from "./run-video-plan.ts";
import { RUN_VIDEO_FILE } from "./run-video-renderer.ts";
import type { RunVideoRendererService } from "./run-video-renderer.ts";
import type { TeachingRecordingStoreService } from "./teaching-recording-store.ts";

/**
 * Assessment tallies. They are recomputed from the Agent Steps rather than
 * incremented alongside them, so a count can never drift from the Steps it
 * claims to summarize.
 */
const assessmentCountsOf = (
  steps: readonly AgentRunStep[]
): AgentRunAssessmentCounts => {
  const counts = { blocked: 0, inconclusive: 0, notWorking: 0, working: 0 };
  for (const step of steps) {
    switch (step.assessment?.outcome) {
      case "working": {
        counts.working += 1;
        break;
      }
      case "not-working": {
        counts.notWorking += 1;
        break;
      }
      case "inconclusive": {
        counts.inconclusive += 1;
        break;
      }
      case "blocked": {
        counts.blocked += 1;
        break;
      }
      default: {
        break;
      }
    }
  }
  return counts;
};

/**
 * How much of the journey the Run actually reached. An executed Step is one
 * the Runner ran to a terminal execution outcome, whatever the agent concluded
 * about it: coverage answers "was this checked", not "did it work".
 */
export const coverageOf = (
  steps: readonly AgentRunStep[]
): AgentRunCoverage => {
  const executed = steps.filter((step) => step.execution === "assessed").length;
  return {
    complete: executed === steps.length,
    executed,
    total: steps.length,
    unexecuted: steps.length - executed,
  };
};

/** Every Agent Step the Run never reached is recorded as never reached. */
const markRemainingUnexecuted = (
  steps: readonly AgentRunStep[]
): readonly AgentRunStep[] =>
  steps.map((step) =>
    step.execution === "pending" || step.execution === "active"
      ? { ...step, execution: "unexecuted" as const }
      : step
  );

export type LiveRun = AgentRunState | TaskAgentRunState;
export const isTaskRun = (run: LiveRun): run is TaskAgentRunState =>
  "schemaVersion" in run;
/** Recompute the derived tallies after any change to the ordered Steps. */
const withDerivedRunTotals = (run: LiveRun): LiveRun =>
  isTaskRun(run)
    ? run
    : {
        ...run,
        assessmentCounts: assessmentCountsOf(run.steps),
        coverage: coverageOf(run.steps),
      };
export const withDryRunTakeover = (
  run: LiveRun | null,
  takeoverOccurred: boolean
): LiveRun | null => {
  if (run === null || !isTaskRun(run) || run.purpose.kind !== "dry-run") {
    return run;
  }
  return { ...run, purpose: { ...run.purpose, takeoverOccurred } };
};

const dryRunPassed = (
  summary: AgentRunSummary,
  hadTakeover: boolean
): boolean =>
  summary.schemaVersion === 3 &&
  summary.outcome === "completed" &&
  summary.purpose.kind === "dry-run" &&
  !summary.purpose.takeoverOccurred &&
  summary.assessment?.outcome === "working" &&
  summary.assessment.outcomeComplete === true &&
  !hadTakeover;

const dryRunObservableOutcome = (summary: AgentRunSummary): string => {
  if (summary.schemaVersion === 3) {
    return summary.assessment?.explanation ?? "No task outcome was assessed.";
  }
  const last = summary.steps.findLast((step) => step.assessment !== null);
  return last === undefined
    ? "No Agent Step was assessed."
    : `Done when: ${last.doneWhen} ${last.assessment?.explanation ?? ""}`.trim();
};

export const runEnded = (run: LiveRun): boolean =>
  isTaskRun(run) ? run.lifecycle.phase === "ended" : run.outcome !== null;

export const endTaskRun = (
  run: TaskAgentRunState,
  outcome: TaskAgentRunSummary["outcome"],
  at: string
): TaskAgentRunState =>
  run.lifecycle.phase === "ended"
    ? run
    : { ...run, lifecycle: { endedAt: at, outcome, phase: "ended" } };

export const endClosedRun = (
  run: LiveRun | null,
  at: string
): LiveRun | null => {
  if (run === null || runEnded(run)) {
    return run;
  }
  if (isTaskRun(run)) {
    return endTaskRun(run, "user-closed", at);
  }
  return withDerivedRunTotals({
    ...run,
    activeStepIndex: null,
    endedAt: at,
    outcome: "interrupted",
    steps: markRemainingUnexecuted(run.steps),
  });
};
export const activateRun = (
  run: LiveRun | null,
  at: string,
  emulation: DraftEmulation
): LiveRun | null => {
  if (run === null) {
    return null;
  }
  if (isTaskRun(run)) {
    return {
      ...run,
      lastAgentActivityAt: at,
      startedAt: at,
      startingEmulation: emulation,
    };
  }
  return withDerivedRunTotals({
    ...run,
    activeStepIndex: 0,
    lastAgentActivityAt: at,
    startedAt: at,
    steps: run.steps.map((step, index) =>
      index === 0 ? { ...step, execution: "active", startedAt: at } : step
    ),
  });
};

/** How a Run's video will play its footage, fixed when the Run ends. */
const runVideoTimeMap = (footage: FootageManifest): RunVideoTimeMap => ({
  fastForward: footage.fastForward,
  segments: planRunVideo(footage),
  startedAt: new Date(footage.startedAt).toISOString(),
});

/** A task Run's Summary, with the time map of the video it captured. */
const withVideoTimeMap = (
  footage: FootageManifest | undefined,
  summary: TaskAgentRunSummary
): TaskAgentRunSummary => {
  if (footage === undefined) {
    return summary;
  }
  return { ...summary, videoTimeMap: runVideoTimeMap(footage) };
};

export interface RunEvidence {
  readonly attempts: Set<string>;
  readonly snapshots: Set<string>;
}
interface FinalizedRun {
  readonly persisted: boolean;
  readonly summary: AgentRunSummary | undefined;
}
/** Shared across session snapshot replacements; retained for persistence retries. */
export const makeRunFinalizationState = () => {
  const registry = AtomRegistry.make();
  const state = Atom.make<FinalizedRun>({
    persisted: false,
    summary: undefined,
  }).pipe(Atom.keepAlive);
  return {
    get persisted() {
      return registry.get(state).persisted;
    },
    set persisted(persisted: boolean) {
      registry.update(state, (current) => ({ ...current, persisted }));
    },
    get summary() {
      return registry.get(state).summary;
    },
    set summary(summary: AgentRunSummary | undefined) {
      registry.update(state, (current) => ({ ...current, summary }));
    },
  };
};
export interface RunFinalizationRecord {
  readonly snapshot: AgentSessionSnapshot;
  readonly dryRunControl: { readonly hadTakeover: boolean };
  readonly artifactDirectory: string | undefined;
  readonly traceFile: string | undefined;
  readonly videoFile: string | undefined;
  readonly footage: RunFootage | undefined;
  readonly runTimeline: readonly AgentTimelineEntry[];
  readonly scope: Scope.Closeable;
  readonly supplied: Map<string, string>;
  readonly finalized: ReturnType<typeof makeRunFinalizationState>;
}
export interface TaskRunUpdate {
  readonly instruction?: string | undefined;
  readonly skills: readonly {
    readonly flowSkillName: FlowSkillName;
    readonly hosts: readonly string[];
    readonly variables: readonly AgentRunTaskVariable[];
  }[];
  readonly inputs: readonly AgentRunTaskInput[];
}

const notRunning = (sessionId: string) =>
  error(
    "agent_session_invalid",
    `Agent Session ${sessionId} is not performing an Interactive Run.`
  );

const assessTaskRun = (
  run: TaskAgentRunState,
  input: Omit<AgentTaskAssessment, "submittedAt">,
  finding: boolean,
  evidence: RunEvidence,
  at: string
) =>
  Effect.gen(function* assessRun() {
    if (
      !finding &&
      run.purpose.kind === "dry-run" &&
      input.outcomeComplete === undefined
    ) {
      return yield* Effect.fail(
        error(
          "agent_session_invalid",
          "Dry Run assessments must explicitly report outcomeComplete."
        )
      );
    }
    if (
      input.evidence.length === 0 ||
      input.explanation.trim().length === 0 ||
      input.evidence.some((reference) => {
        if (reference.kind === "snapshot") {
          return !evidence.snapshots.has(reference.id);
        }
        if (reference.kind === "attempt") {
          return !evidence.attempts.has(reference.id);
        }
        return true;
      })
    ) {
      return yield* Effect.fail(
        error(
          "agent_session_invalid",
          "Cite a Browser Snapshot or attempt produced by this Run and explain the assessment."
        )
      );
    }

    const assessment = { ...input, submittedAt: at };

    return {
      ...run,
      assessment: finding ? run.assessment : assessment,
      findings: finding
        ? [...run.findings, { ...assessment, id: `finding-${randomUUID()}` }]
        : run.findings,
      lastAgentActivityAt: at,
    };
  });

const requireTaskUpdate = (run: TaskAgentRunState) =>
  run.purpose.kind === "dry-run"
    ? Effect.fail(
        error(
          "agent_session_invalid",
          "A Dry Run assesses the saved complete skill outcome under its Teaching hosts. Start a fresh Dry Run to change inputs."
        )
      )
    : Effect.void;
const withTaskUpdate = (
  run: TaskAgentRunState,
  input: TaskRunUpdate,
  at: string
): TaskAgentRunState => {
  const referencedSkills = [...run.referencedSkills];
  const variables = [...run.variables];
  for (const skill of input.skills) {
    if (
      !referencedSkills.some(
        (reference) => reference.flowSkillName === skill.flowSkillName
      )
    ) {
      referencedSkills.push({
        flowSkillName: skill.flowSkillName,
        referencedAt: at,
      });
      variables.push(...skill.variables);
    }
  }
  const inputs = [...run.inputs];
  for (const supplied of input.inputs) {
    const existing = inputs.findIndex(
      (value) =>
        value.flowSkillName === supplied.flowSkillName &&
        value.name === supplied.name
    );
    if (existing === -1) {
      inputs.push(supplied);
    } else {
      inputs[existing] = supplied;
    }
  }
  return {
    ...run,
    assessment: input.instruction === undefined ? run.assessment : null,
    inputs,
    instructions:
      input.instruction === undefined
        ? run.instructions
        : [
            ...run.instructions,
            { instruction: input.instruction, receivedAt: at },
          ],
    lastAgentActivityAt: at,
    referencedSkills,
    variables,
  };
};

/** Capture and storage details stay behind the lifecycle interface. Session mutations remain serialized by the session owner. */
export const makeRunLifecycle = (dependencies: {
  readonly now: () => Date;
  readonly fileSystem: FileSystem.FileSystem | undefined;
  readonly runStore: AgentRunStoreService | undefined;
  readonly teachingRecordingStore: TeachingRecordingStoreService | undefined;
  readonly runVideoRenderer: RunVideoRendererService | undefined;
}) => {
  const {
    now,
    fileSystem,
    runStore,
    teachingRecordingStore,
    runVideoRenderer,
  } = dependencies;

  /**
   * Where a finished artifact sits inside the Run's own directory. The Run
   * Summary stores the relative name so the package can be moved or read
   * from another process without rewriting absolute paths.
   */
  const finalArtifactPath = (
    record: RunFinalizationRecord,
    file: string | undefined
  ): Effect.Effect<string | null> => {
    if (file === undefined || record.artifactDirectory === undefined) {
      return Effect.succeed(null);
    }
    const relative = path.relative(record.artifactDirectory, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return Effect.succeed(null);
    }
    return fileSystem === undefined
      ? Effect.succeed(relative)
      : fileSystem.exists(file).pipe(
          Effect.map((exists) => (exists ? relative : null)),
          Effect.orElseSucceed(() => null)
        );
  };

  /**
   * The video a finished Run's Summary names. Footage is condensed after
   * the Run ends, so the Summary names the file it will become.
   */
  const runVideoPath = (
    record: RunFinalizationRecord,
    footage: FootageManifest | undefined
  ): Effect.Effect<string | null> =>
    footage === undefined
      ? finalArtifactPath(record, record.videoFile)
      : Effect.succeed(RUN_VIDEO_FILE);

  /** Start condensing a finished Run's footage into its video. */
  const condenseRunVideo = (
    record: RunFinalizationRecord,
    footage: FootageManifest | undefined
  ): Effect.Effect<void> =>
    footage === undefined ||
    record.artifactDirectory === undefined ||
    runVideoRenderer === undefined
      ? Effect.void
      : runVideoRenderer.render(record.artifactDirectory);

  /**
   * Write the Run Summary under the Catalog Root. A Run's evidence is worth
   * nothing the caller cannot reach, so persistence is part of ending a Run
   * rather than of the tool that reports it ended.
   */
  const persistRunSummary = (
    record: RunFinalizationRecord,
    summary: AgentRunSummary
  ): Effect.Effect<AgentRunSummary, AgentSessionError> => {
    if (record.snapshot.dryRun !== null) {
      return Effect.gen(function* persistDryRunSummary() {
        const { dryRun } = record.snapshot;
        const directory = record.artifactDirectory;
        if (
          dryRun === null ||
          directory === undefined ||
          fileSystem === undefined ||
          teachingRecordingStore === undefined
        ) {
          return yield* Effect.fail(
            error(
              "agent_session_unavailable",
              "The Dry Run has no Teaching evidence store."
            )
          );
        }
        yield* fileSystem
          .writeFileString(
            path.join(directory, "summary.json"),
            `${JSON.stringify(Schema.encodeSync(AgentRunSummary)(summary), null, 2)}\n`,
            { mode: 0o600 }
          )
          .pipe(
            Effect.mapError((cause) =>
              error(
                "agent_session_unavailable",
                `Could not save the Dry Run Summary: ${cause.message}`
              )
            )
          );
        const passed = dryRunPassed(summary, record.dryRunControl.hadTakeover);
        const mutation = {
          observableOutcome: dryRunObservableOutcome(summary),
          operationId: OperationId.make(`dry-run-finish-${summary.sessionId}`),
          recordingId: dryRun.recordingId,
          summary,
        };
        const manifest = yield* teachingRecordingStore
          .read(dryRun.recordingId)
          .pipe(
            Effect.mapError((cause) =>
              error(
                "agent_session_unavailable",
                `Could not read the Dry Run: ${cause.message}`
              )
            )
          );
        if (manifest.lifecycle._tag === "dry-running") {
          yield* (
            passed
              ? teachingRecordingStore.passDryRun(mutation)
              : teachingRecordingStore.failDryRun(mutation)
          ).pipe(
            Effect.mapError((cause) =>
              error(
                "agent_session_unavailable",
                `Could not finish the Dry Run: ${cause.message}`
              )
            )
          );
        } else if (
          manifest.lifecycle._tag === "dry-run-failed" &&
          manifest.lifecycle.dryRunSummary === undefined
        ) {
          yield* teachingRecordingStore
            .attachDryRunSummary({
              operationId: OperationId.make(
                `dry-run-summary-${summary.sessionId}`
              ),
              recordingId: dryRun.recordingId,
              summary,
            })
            .pipe(
              Effect.mapError((cause) =>
                error(
                  "agent_session_unavailable",
                  `Could not attach the Dry Run Summary: ${cause.message}`
                )
              )
            );
        }
        record.finalized.persisted = true;
        return summary;
      });
    }
    if (runStore === undefined) {
      return Effect.sync(() => {
        record.finalized.persisted = true;
        return summary;
      });
    }
    return runStore.write(summary).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          record.finalized.persisted = true;
        })
      ),
      Effect.mapError((cause) =>
        error(
          "agent_session_unavailable",
          `Run ${summary.runId} ended but its Run Summary could not be written: ${cause.message}`
        )
      )
    );
  };

  /** Seal once, retain the summary before writing, and retry only persistence after a failed write. */
  const finalize = Effect.fn("RunLifecycle.finalize")(
    function* finalizeInteractiveRun(
      record: RunFinalizationRecord,
      mutate: (
        change: (snapshot: AgentSessionSnapshot) => AgentSessionSnapshot
      ) => Effect.Effect<AgentSessionSnapshot | undefined, AgentSessionError>,
      summaryText?: string
    ) {
      const sessionId = record.snapshot.id;
      if (record.snapshot.run === null) {
        return yield* Effect.fail(notRunning(sessionId));
      }
      const already = record.finalized.summary;
      if (already !== undefined) {
        // A closing account that arrives after the Run already ended is
        // recorded on the Summary it belongs to; nothing else is rewritten.
        const amended =
          summaryText === undefined ||
          ("agentAccount" in already && already.agentAccount !== undefined)
            ? already
            : { ...already, agentAccount: summaryText };
        // A Run whose write never landed is not a persisted Run. This is the
        // path a caller retries, so it writes rather than answering with a
        // Summary the Catalog Root has never seen.
        if (record.finalized.persisted && amended === already) {
          return already;
        }
        // The amended Summary joins the session only once its write lands.
        // A failed amend leaves memory on the last persisted Summary, so the
        // next retry still sees a closing account the Catalog Root lacks.
        const written = yield* persistRunSummary(record, amended);
        record.finalized.summary = written;
        return written;
      }
      return yield* Effect.uninterruptibleMask(() =>
        Effect.gen(function* finalizeRun() {
          const at = now().toISOString();
          // A read-modify-write over the Run as it stands when the write
          // lands: an outcome already recorded is kept, never clobbered by a
          // snapshot this call built earlier.
          const completed = yield* mutate((snapshot) => {
            if (snapshot.run === null) {
              return snapshot;
            }
            if (isTaskRun(snapshot.run)) {
              return {
                ...snapshot,
                boundary: null,
                controller: "agent",
                pendingDecisions: [],
                phase: "completed",
                run: endTaskRun(snapshot.run, "completed", at),
                takeover: null,
                updatedAt: at,
              };
            }
            const steps = markRemainingUnexecuted(snapshot.run.steps);
            return {
              ...snapshot,
              boundary: null,
              controller: "agent",
              phase: "completed",
              run: withDerivedRunTotals({
                ...snapshot.run,
                activeStepIndex: null,
                endedAt: snapshot.run.endedAt ?? at,
                // A Run the agent stopped while Agent Steps remained is not
                // a completed Run: the coverage it did not reach is visible
                // here.
                outcome:
                  snapshot.run.outcome ??
                  (steps.every((step) => step.execution === "assessed")
                    ? ("completed" as const)
                    : ("ended-early" as const)),
                steps,
              }),
              takeover: null,
              updatedAt: at,
            };
          });
          const finished = completed?.run;
          if (
            completed === undefined ||
            finished === null ||
            finished === undefined
          ) {
            return yield* Effect.fail(notRunning(sessionId));
          }
          // Closing the session scope stops tracing and seals the footage.
          // Nothing may write to the Run's artifacts after this point.
          yield* Scope.close(record.scope, Exit.void);
          const footage = record.footage?.manifest();
          const commonSummary = {
            attribution: finished.attribution,
            runId: finished.runId,
            sessionId,
            startedAt: finished.startedAt,
            timeline: [
              ...new Map(
                [...record.runTimeline, ...completed.timeline].map((entry) => [
                  entry.id,
                  entry,
                ])
              ).values(),
            ].toSorted((left, right) => left.at.localeCompare(right.at)),
            title: finished.title,
            tracePath: yield* finalArtifactPath(record, record.traceFile),
            videoPath: yield* runVideoPath(record, footage),
          };
          const ended: AgentRunSummary = isTaskRun(finished)
            ? withVideoTimeMap(footage, {
                ...finished,
                ...commonSummary,
                endedAt:
                  finished.lifecycle.phase === "ended"
                    ? finished.lifecycle.endedAt
                    : at,
                outcome:
                  finished.lifecycle.phase === "ended"
                    ? finished.lifecycle.outcome
                    : "completed",
              })
            : {
                ...commonSummary,
                assessmentCounts: finished.assessmentCounts,
                coverage: finished.coverage,
                endedAt: finished.endedAt ?? at,
                flowSkillName: finished.flowSkillName,
                inputs: finished.inputs,
                outcome: finished.outcome ?? "ended-early",
                schemaVersion: 2,
                steps: finished.steps,
                videoPath: yield* finalArtifactPath(record, record.videoFile),
              };
          yield* mutate((snapshot) => ({
            ...snapshot,
            phase: "closed",
            updatedAt: now().toISOString(),
          }));
          const summary =
            summaryText === undefined
              ? ended
              : { ...ended, agentAccount: summaryText };
          record.finalized.summary = Schema.decodeUnknownSync(AgentRunSummary)(
            Schema.encodeSync(AgentRunSummary)(summary)
          );
          record.supplied.clear();
          yield* condenseRunVideo(record, footage);
          return yield* persistRunSummary(record, record.finalized.summary);
        })
      );
    }
  );

  return {
    assess: assessTaskRun,
    finalize,
    update: <E>(
      run: TaskAgentRunState,
      prepare: Effect.Effect<TaskRunUpdate, E>
    ) =>
      Effect.gen(function* updateRun() {
        yield* requireTaskUpdate(run);
        const input = yield* prepare;
        const at = now().toISOString();
        return { at, input, run: withTaskUpdate(run, input, at) };
      }),
  };
};
