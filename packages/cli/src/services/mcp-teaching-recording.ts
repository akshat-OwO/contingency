import path from "node:path";

import {
  AgentSessionSnapshot,
  FlowSkillName,
  FlowSkillDiagnostic,
  FlowSkillFile,
  FlowSkillSaveResult,
  OperationId,
  TEACHING_RECORDING_WAIT_MAX_MS,
  TeachingKeyframeContent,
  TeachingRecordingClaim,
  TeachingRecordingId,
  TeachingRecordingList,
  TeachingRecordingSummary,
  TeachingTimeline,
} from "@contingency/protocol";
import type { TeachingRecordingManifest } from "@contingency/protocol";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import { AgentSession } from "./agent-session.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import {
  TeachingRecordingLearning,
  TeachingRecordingLearningLive,
} from "./teaching-recording-learning.ts";
import type { TeachingRecordingLearningError } from "./teaching-recording-learning.ts";
import { TeachingRecordingStore } from "./teaching-recording-store.ts";
import type { TeachingRecordingStoreError } from "./teaching-recording-store.ts";

// `Schema.Error` is a class factory, not a thrown error.
// oxlint-disable-next-line unicorn/throw-new-error
class TeachingRecordingFailure extends Schema.Error<TeachingRecordingFailure>(
  "TeachingRecordingFailure"
)({
  code: Schema.String,
  diagnostics: Schema.Array(FlowSkillDiagnostic),
  message: Schema.String,
}) {}

const failure = (
  cause: TeachingRecordingLearningError | TeachingRecordingStoreError
) =>
  new TeachingRecordingFailure({
    code: cause.code,
    diagnostics: "diagnostics" in cause ? cause.diagnostics : [],
    message: `${cause.message} (${cause.code})`,
  });

const sessionFailure = (cause: {
  readonly code: string;
  readonly message: string;
}) =>
  new TeachingRecordingFailure({
    code: cause.code,
    diagnostics: [],
    message: `${cause.message} (${cause.code})`,
  });

const summaryOf = (
  manifest: TeachingRecordingManifest
): typeof TeachingRecordingSummary.Type => {
  const { lifecycle } = manifest;
  if (
    lifecycle._tag !== "recording" &&
    lifecycle._tag !== "ready" &&
    lifecycle._tag !== "learning" &&
    lifecycle._tag !== "skill-drafted" &&
    lifecycle._tag !== "dry-running" &&
    lifecycle._tag !== "dry-run-failed" &&
    lifecycle._tag !== "dry-run-passed" &&
    lifecycle._tag !== "verified" &&
    lifecycle._tag !== "failed"
  ) {
    throw new Error(
      `Teaching Recording ${manifest.recordingId} has no learning-agent state.`
    );
  }
  let lifecycleFailure: string | null = null;
  if (lifecycle._tag === "failed") {
    lifecycleFailure = lifecycle.error;
  }
  if (lifecycle._tag === "dry-run-failed") {
    lifecycleFailure = lifecycle.dryRunResult.observableOutcome;
  }
  return {
    cleanup: manifest.cleanup,
    failure: lifecycleFailure,
    flowSkillName: manifest.flowSkillName,
    lifecycle: lifecycle._tag,
    recordingId: manifest.recordingId,
    updatedAt: manifest.updatedAt,
  };
};

// A no-argument tool uses a record because an empty Struct advertises an array.
const NoParameters = Schema.Record(Schema.String, Schema.Unknown);

const TeachingRecordingsListTool = Tool.make("agent_teaching_recordings_list", {
  dependencies: [TeachingRecordingLearning],
  description:
    "List process-independent Teaching Recordings that an agent can claim for Flow Skill learning. Recordings created by contingency web appear after Stop, even when this MCP process did not create their browser session.",
  failure: TeachingRecordingFailure,
  parameters: NoParameters,
  success: TeachingRecordingList,
});

const TeachingRecordingWaitTool = Tool.make("agent_teaching_recording_wait", {
  dependencies: [TeachingRecordingLearning],
  description:
    "Wait for a named Teaching Recording to reach its next durable state: recording, ready, learning, skill-drafted, dry-running, dry-run-failed, dry-run-passed, verified, or failed. The tool polls its durable manifest, so it works when another process owns the browser. The timeout is at most 60000 ms.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    recordingId: TeachingRecordingId,
    timeoutMs: Schema.optional(
      Schema.NullOr(
        Schema.Int.check(
          Schema.isBetween({
            maximum: TEACHING_RECORDING_WAIT_MAX_MS,
            minimum: 0,
          })
        )
      )
    ),
  }),
  success: TeachingRecordingSummary,
});

const TeachingRecordingClaimTool = Tool.make("agent_teaching_recording_claim", {
  dependencies: [TeachingRecordingStore],
  description:
    "Claim one ready Teaching Recording for Flow Skill learning. The durable claim is exclusive across processes and lasts through saving, Dry Runs, and a rejection, until agent_flow_skill_verify, agent_teaching_recording_release, or agent_teaching_recording_fail ends it. An abandoned claim returns to ready after its owner exits. Replay the same operation id to reread the claim.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: TeachingRecordingClaim,
});

const TeachingTimelineGetTool = Tool.make("agent_teaching_timeline_get", {
  dependencies: [TeachingRecordingLearning],
  description:
    "Read one bounded page of a claimed Teaching Recording's semantic timeline. Actions include before, after, appeared, and disappeared accessibility evidence. Instructions and URL transitions stay in order. Keyframes are id and hash references only. Follow nextCursor until it is null.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    claimOperationId: OperationId,
    cursor: Schema.optional(
      Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
    ),
    recordingId: TeachingRecordingId,
  }),
  success: TeachingTimeline,
});

const TeachingKeyframeGetTool = Tool.make("agent_teaching_keyframe_get", {
  dependencies: [TeachingRecordingLearning],
  description:
    "Fetch one PNG keyframe from a claimed Teaching Recording by the id returned in its semantic timeline. The timeline does not embed images or expose local artifact paths.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    claimOperationId: OperationId,
    keyframeId: Schema.String.check(Schema.isMinLength(1)),
    recordingId: TeachingRecordingId,
  }),
  success: TeachingKeyframeContent,
});

const FlowSkillSaveTool = Tool.make("agent_flow_skill_save", {
  dependencies: [TeachingRecordingLearning],
  description:
    'Atomically save a proposed Flow Skill package for the claimed Teaching Recording. The same claim operation id saves again after a failed Dry Run or a rejection, which replaces the package and returns the recording to skill-drafted. A save is refused while a Dry Run is running, and after a passing Dry Run until the user rejects or verifies the flow. SKILL.md needs YAML frontmatter whose name matches the Flow Skill, a description, every {{placeholder}} declared under inputs, and a "Done when:" line on each numbered step. Optional files under references/ must be reachable from a link. A refusal returns one diagnostic per broken property and leaves any previous package unchanged.',
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    claimOperationId: OperationId,
    files: Schema.Array(FlowSkillFile),
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: FlowSkillSaveResult,
});

const DryRunInput = Schema.Struct({
  changed: Schema.Boolean,
  name: Schema.String.check(Schema.isMinLength(1)),
  secret: Schema.Boolean,
  value: Schema.String,
});

const FlowSkillDryRunStartTool = Tool.make("agent_flow_skill_dry_run_start", {
  dependencies: [AgentSession, FileSystem.FileSystem, TeachingRecordingStore],
  description:
    "Start a saved Flow Skill in a fresh browser context with the Teaching Recording's Emulation. Ask for every required input again, mark inputs changed from the demonstration when the task permits it, and mark secrets so their values are not persisted. Drive the returned Agent Session with the browser tools, then report the observable outcome.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    inputs: Schema.Array(DryRunInput),
    operationId: OperationId,
    recordingId: TeachingRecordingId,
    url: Schema.String.check(Schema.isMinLength(1)),
  }),
  success: Schema.Struct({
    files: Schema.Array(FlowSkillFile),
    flowSkillName: FlowSkillName,
    recordingId: TeachingRecordingId,
    session: AgentSessionSnapshot,
    skillPath: Schema.String.check(Schema.isMinLength(1)),
  }),
});

const FlowSkillDryRunReportTool = Tool.make("agent_flow_skill_dry_run_report", {
  dependencies: [AgentSession, TeachingRecordingStore],
  description:
    "Report whether the active Dry Run reached the Flow Skill's stated observable outcome. This persists only the redacted inputs, completion time, and outcome. A pass keeps every Teaching artifact until the user explicitly verifies the flow. A failure keeps every Teaching artifact and this process's learning claim: fix the package with agent_flow_skill_save under the same claim operation id, then start another Dry Run.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    observableOutcome: Schema.String.check(Schema.isMinLength(1)),
    operationId: OperationId,
    outcome: Schema.Literals(["failed", "passed"]),
    recordingId: TeachingRecordingId,
  }),
  success: TeachingRecordingSummary,
});

const FlowSkillRejectTool = Tool.make("agent_flow_skill_reject", {
  dependencies: [AgentSession, TeachingRecordingStore],
  description:
    "Relay the user's explicit rejection after a passing Dry Run. The Flow Skill returns to drafted and every Teaching artifact and the learning claim stay available, so agent_flow_skill_save under the same claim operation id can edit the package for another Dry Run.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: TeachingRecordingSummary,
});

const FlowSkillVerifyTool = Tool.make("agent_flow_skill_verify", {
  dependencies: [AgentSession, TeachingRecordingStore],
  description:
    "Relay the user's explicit Verify flow choice after a passing Dry Run. Verification marks cleanup purge-pending before deleting raw Teaching artifacts. Never call this tool without the user's explicit choice.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: TeachingRecordingSummary,
});

const FlowSkillCleanupRetryTool = Tool.make("agent_flow_skill_cleanup_retry", {
  dependencies: [AgentSession, TeachingRecordingStore],
  description:
    "Retry deletion for a verified Flow Skill whose cleanup remains purge-pending. The verified Flow Skill is never rolled back when deletion fails.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: TeachingRecordingSummary,
});

const TeachingRecordingReleaseTool = Tool.make(
  "agent_teaching_recording_release",
  {
    dependencies: [TeachingRecordingStore],
    description:
      "Release this process's learning claim and return the Teaching Recording to ready for another attempt. This works from any claimed state, including a drafted or dry-run-failed Flow Skill. Supply the original claim operation id and a fresh mutation operation id.",
    failure: TeachingRecordingFailure,
    parameters: Schema.Struct({
      claimOperationId: OperationId,
      operationId: OperationId,
      recordingId: TeachingRecordingId,
    }),
    success: TeachingRecordingSummary,
  }
);

const TeachingRecordingFailTool = Tool.make("agent_teaching_recording_fail", {
  dependencies: [TeachingRecordingStore],
  description:
    "Record why this process could not learn the Flow Skill and end its claim. The failed recording remains discoverable and another attempt can claim it.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    claimOperationId: OperationId,
    error: Schema.String.check(Schema.isMinLength(1)),
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: TeachingRecordingSummary,
});

export const TeachingRecordingTools = withStrictParameters(
  Toolkit.make(
    TeachingRecordingsListTool,
    TeachingRecordingWaitTool,
    TeachingRecordingClaimTool,
    TeachingTimelineGetTool,
    TeachingKeyframeGetTool,
    FlowSkillSaveTool,
    FlowSkillDryRunStartTool,
    FlowSkillDryRunReportTool,
    FlowSkillRejectTool,
    FlowSkillVerifyTool,
    FlowSkillCleanupRetryTool,
    TeachingRecordingReleaseTool,
    TeachingRecordingFailTool
  )
);

export const TeachingRecordingToolHandlersLive = TeachingRecordingTools.toLayer(
  {
    agent_flow_skill_cleanup_retry: (params) =>
      Effect.gen(function* retryFlowSkillCleanup() {
        const store = yield* TeachingRecordingStore;
        const sessions = yield* AgentSession;
        const cleaned = yield* store
          .cleanup(params)
          .pipe(Effect.mapError(failure));
        yield* sessions.get(cleaned.sessionId).pipe(Effect.ignore);
        return summaryOf(cleaned);
      }),
    agent_flow_skill_dry_run_report: (params) =>
      Effect.gen(function* reportFlowSkillDryRun() {
        const store = yield* TeachingRecordingStore;
        const sessions = yield* AgentSession;
        const current = yield* store
          .read(params.recordingId)
          .pipe(Effect.mapError(failure));
        const receiptOperation =
          params.outcome === "passed" ? "pass-dry-run" : "fail-dry-run";
        const replay = current.receipts.some(
          (receipt) =>
            receipt.operation === receiptOperation &&
            receipt.operationId === params.operationId
        );
        if (current.lifecycle._tag !== "dry-running" && !replay) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_conflict",
              diagnostics: [],
              message: `Teaching Recording ${params.recordingId} has no active Dry Run. (teaching_recording_conflict)`,
            })
          );
        }
        const dryRunSessionId =
          "dryRunSessionId" in current.lifecycle
            ? current.lifecycle.dryRunSessionId
            : undefined;
        const reported = yield* (
          params.outcome === "passed"
            ? store.passDryRun(params)
            : store.failDryRun(params)
        ).pipe(Effect.mapError(failure));
        if (dryRunSessionId !== undefined) {
          yield* sessions
            .close(dryRunSessionId, params.operationId)
            .pipe(Effect.ignore);
        }
        yield* sessions.get(reported.sessionId).pipe(Effect.ignore);
        return summaryOf(reported);
      }),
    agent_flow_skill_dry_run_start: (params) =>
      Effect.gen(function* startFlowSkillDryRun() {
        const store = yield* TeachingRecordingStore;
        const sessions = yield* AgentSession;
        const fileSystem = yield* FileSystem.FileSystem;
        const manifest = yield* store
          .read(params.recordingId)
          .pipe(Effect.mapError(failure));
        const replay = manifest.receipts.some(
          (receipt) =>
            receipt.operation === "start-dry-run" &&
            receipt.operationId === params.operationId
        );
        if (
          manifest.lifecycle._tag !== "skill-drafted" &&
          manifest.lifecycle._tag !== "dry-run-failed" &&
          !replay
        ) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_conflict",
              diagnostics: [],
              message: `Teaching Recording ${params.recordingId} cannot start a Dry Run from ${manifest.lifecycle._tag}. (teaching_recording_conflict)`,
            })
          );
        }
        const session = yield* sessions
          .start({
            activity: "run",
            clientName: "flow-skill-dry-run",
            clientVersion: "1",
            emulation: manifest.emulation,
            operationId: params.operationId,
            url: params.url,
            viewport: manifest.emulation.viewport,
          })
          .pipe(Effect.mapError(sessionFailure));
        const started = yield* store
          .startDryRun({
            inputs: params.inputs.map(({ changed, name, secret, value }) => ({
              changed,
              name,
              value: secret ? null : value,
            })),
            operationId: params.operationId,
            recordingId: params.recordingId,
            sessionId: session.id,
          })
          .pipe(
            Effect.tapError(() =>
              sessions.close(session.id, params.operationId).pipe(Effect.ignore)
            ),
            Effect.mapError(failure)
          );
        if (started.lifecycle._tag !== "dry-running") {
          return yield* Effect.die(
            "A started Dry Run did not enter dry-running."
          );
        }
        const catalogRoot = path.dirname(
          path.dirname(store.directory(started.recordingId))
        );
        const skillDirectory = path.dirname(
          path.join(catalogRoot, started.lifecycle.skillPath)
        );
        const fileNames = yield* fileSystem
          .readDirectory(skillDirectory, { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new TeachingRecordingFailure({
                  code: "teaching_recording_io",
                  diagnostics: [],
                  message: `Could not read the Flow Skill package: ${cause.message} (teaching_recording_io)`,
                })
            )
          );
        const files = yield* Effect.forEach(
          fileNames.filter(
            (file) =>
              file === "SKILL.md" || file.startsWith(`references${path.sep}`)
          ),
          (file) =>
            fileSystem.readFileString(path.join(skillDirectory, file)).pipe(
              Effect.map((content) => ({
                content,
                path: file.split(path.sep).join("/"),
              })),
              Effect.mapError(
                (cause) =>
                  new TeachingRecordingFailure({
                    code: "teaching_recording_io",
                    diagnostics: [],
                    message: `Could not read Flow Skill file ${file}: ${cause.message} (teaching_recording_io)`,
                  })
              )
            )
        );
        yield* sessions.get(started.sessionId).pipe(Effect.ignore);
        // An Agent Session lives in the process that started it, so a Stop from
        // the Workspace can only persist the transition. This process watches
        // the durable manifest and closes its own Chromium once the Dry Run
        // leaves dry-running, whichever process ended it.
        yield* Effect.forkDetach(
          Effect.sleep("1 second").pipe(
            Effect.andThen(store.read(params.recordingId)),
            Effect.map((current) => current.lifecycle._tag !== "dry-running"),
            Effect.catchCause(() => Effect.succeed(true)),
            Effect.repeat({ until: (ended: boolean) => ended }),
            Effect.andThen(
              sessions.close(session.id, params.operationId).pipe(Effect.ignore)
            )
          )
        );
        return {
          files,
          flowSkillName: started.flowSkillName,
          recordingId: started.recordingId,
          session,
          skillPath: started.lifecycle.skillPath,
        };
      }),
    agent_flow_skill_reject: (params) =>
      Effect.gen(function* rejectFlowSkill() {
        const store = yield* TeachingRecordingStore;
        const sessions = yield* AgentSession;
        const rejected = yield* store
          .reject(params)
          .pipe(Effect.mapError(failure));
        yield* sessions.get(rejected.sessionId).pipe(Effect.ignore);
        return summaryOf(rejected);
      }),
    agent_flow_skill_save: (params) =>
      Effect.gen(function* saveFlowSkill() {
        const learning = yield* TeachingRecordingLearning;
        return yield* learning.save(params).pipe(Effect.mapError(failure));
      }),
    agent_flow_skill_verify: (params) =>
      Effect.gen(function* verifyFlowSkill() {
        const store = yield* TeachingRecordingStore;
        const sessions = yield* AgentSession;
        yield* store.verify(params).pipe(Effect.mapError(failure));
        const cleaned = yield* store
          .cleanup(params)
          .pipe(Effect.mapError(failure));
        yield* sessions.get(cleaned.sessionId).pipe(Effect.ignore);
        return summaryOf(cleaned);
      }),
    agent_teaching_keyframe_get: (params) =>
      Effect.gen(function* readTeachingKeyframe() {
        const learning = yield* TeachingRecordingLearning;
        return yield* learning
          .keyframe(
            params.recordingId,
            params.claimOperationId,
            params.keyframeId
          )
          .pipe(Effect.mapError(failure));
      }),
    agent_teaching_recording_claim: (params) =>
      Effect.gen(function* claimTeachingRecording() {
        const store = yield* TeachingRecordingStore;
        const manifest = yield* store
          .startLearning(params)
          .pipe(Effect.mapError(failure));
        if (
          manifest.lifecycle._tag !== "learning" ||
          manifest.lifecycle.claim.operationId !== params.operationId ||
          manifest.lifecycle.claim.ownerPid !== process.pid
        ) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_conflict",
              diagnostics: [],
              message: `Teaching Recording ${params.recordingId} no longer has this learning claim. (teaching_recording_conflict)`,
            })
          );
        }
        return {
          claimedAt: manifest.lifecycle.claim.claimedAt,
          flowSkillName: manifest.flowSkillName,
          operationId: manifest.lifecycle.claim.operationId,
          recordingId: manifest.recordingId,
        };
      }),
    agent_teaching_recording_fail: (params) =>
      Effect.gen(function* failTeachingRecording() {
        const store = yield* TeachingRecordingStore;
        return summaryOf(
          yield* store.failLearning(params).pipe(Effect.mapError(failure))
        );
      }),
    agent_teaching_recording_release: (params) =>
      Effect.gen(function* releaseTeachingRecording() {
        const store = yield* TeachingRecordingStore;
        return summaryOf(
          yield* store.releaseLearning(params).pipe(Effect.mapError(failure))
        );
      }),
    agent_teaching_recording_wait: (params) =>
      Effect.gen(function* waitForTeachingRecording() {
        const learning = yield* TeachingRecordingLearning;
        return yield* learning
          .wait(params.recordingId, params.timeoutMs ?? 30_000)
          .pipe(Effect.mapError(failure));
      }),
    agent_teaching_recordings_list: () =>
      Effect.gen(function* listTeachingRecordings() {
        const learning = yield* TeachingRecordingLearning;
        const recordings = yield* learning
          .list()
          .pipe(Effect.mapError(failure));
        return { recordings };
      }),
    agent_teaching_timeline_get: (params) =>
      Effect.gen(function* readTeachingTimeline() {
        const learning = yield* TeachingRecordingLearning;
        return yield* learning
          .timeline({ ...params, cursor: params.cursor ?? 0 })
          .pipe(Effect.mapError(failure));
      }),
  }
).pipe(Layer.provide(TeachingRecordingLearningLive));

export const McpTeachingRecordingLayer = McpServer.toolkit(
  TeachingRecordingTools
).pipe(Layer.provide(TeachingRecordingToolHandlersLive));
