import {
  AgentRunTaskInput,
  compactAgentSession,
  FlowSkillName,
  FlowSkillDiagnostic,
  FlowSkillFile,
  FlowSkillSaveResult,
  OperationId,
  optionalNullable,
  TeachingKeyframeFile,
  TeachingRecordingClaim,
  TeachingRecordingId,
  TeachingRecordingSummary,
  TeachingTimeline,
} from "@contingency/protocol";
import type { TeachingRecordingManifest } from "@contingency/protocol";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { AgentSession } from "./agent-session.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import {
  UnpublishedEmulation,
  UnpublishedSession,
  WorkspaceLinkGuidance,
  encodeUnpublishedEmulation,
  encodeUnpublishedSession,
  sessionViewParameter,
  workspaceLinkGuidance,
} from "./mcp-session-output.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";
import { fromAgent } from "./session-events.ts";
import {
  TeachingRecordingLearning,
  TeachingRecordingLearningLive,
} from "./teaching-recording-learning.ts";
import type { TeachingRecordingLearningError } from "./teaching-recording-learning.ts";
import {
  decideFlowSkill,
  startDryRun,
  teachingRecordingSummary,
} from "./teaching-recording-orchestration.ts";
import type { TeachingRecordingOrchestrationError } from "./teaching-recording-orchestration.ts";
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
  cause:
    | TeachingRecordingLearningError
    | TeachingRecordingOrchestrationError
    | TeachingRecordingStoreError
) =>
  new TeachingRecordingFailure({
    code: cause.code,
    diagnostics: "diagnostics" in cause ? cause.diagnostics : [],
    message: `${cause.message} (${cause.code})`,
  });

/**
 * A recording summary as the catalog publishes it. Its Emulation is the
 * protocol shape, encoded but not republished in each tool that answers with
 * a summary (ADR 0045).
 */
const PublishedRecordingSummary = Schema.Struct({
  ...TeachingRecordingSummary.fields,
  emulation: UnpublishedEmulation,
});

const PublishedRecordingList = Schema.Struct({
  recordings: Schema.Array(PublishedRecordingSummary),
});

const PublishedClaimResult = Schema.Struct({
  claim: Schema.NullOr(TeachingRecordingClaim),
  recording: PublishedRecordingSummary,
});

const publishSummary = (summary: TeachingRecordingSummary) =>
  encodeUnpublishedEmulation(summary.emulation).pipe(
    Effect.map((emulation) => ({ ...summary, emulation }))
  );

/** Every state a claim or decision lands in has a learning-agent summary. */
const summaryOf = (manifest: TeachingRecordingManifest) => {
  const summary = teachingRecordingSummary(manifest);
  return summary === undefined
    ? Effect.die(
        `Teaching Recording ${manifest.recordingId} has no learning-agent state.`
      )
    : publishSummary(summary);
};

const TeachingRecordingsListTool = readOnly(
  Tool.make("agent_teaching_recordings_list", {
    dependencies: [TeachingRecordingLearning],
    description:
      "List process-independent Teaching Recordings for Flow Skill learning. Name recordingId to filter one recording. Returns immediately. For a session owned by this MCP process, wait with agent_session_get. Otherwise retry the same recordingId about once per second while the list is empty or its lifecycle is recording. Learn when ready; inspect failed capture errors. Stop retrying if the user cancels.",
    failure: TeachingRecordingFailure,
    parameters: Schema.Struct({
      recordingId: Schema.optional(Schema.NullOr(TeachingRecordingId)),
    }),
    success: PublishedRecordingList,
  })
);

const TeachingRecordingClaimTool = Tool.make("agent_teaching_recording_claim", {
  dependencies: [TeachingRecordingStore],
  description:
    'Move this process\'s learning claim on one Teaching Recording. `action:"take"` claims a ready recording and answers with the claim; the durable claim is exclusive across processes and lasts through saving, Dry Runs, and a rejection. `action:"release"` ends the claim and returns the recording to ready for another attempt, from any claimed state including a drafted or dry-run-failed Flow Skill. `action:"fail"` ends the claim and records `error`, why this process could not learn the Flow Skill; the failed recording stays discoverable and accepts a later claim. Release and fail need the original claimOperationId beside a fresh operationId; take needs only its own operationId, and replaying it rereads the same claim. An abandoned claim returns to ready after its owner exits.',
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    action: Schema.Literals(["take", "release", "fail"]),
    claimOperationId: Schema.optional(Schema.NullOr(OperationId)),
    error: Schema.optional(Schema.NullOr(Schema.String)),
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: PublishedClaimResult,
});

const TeachingTimelineGetTool = readOnly(
  Tool.make("agent_teaching_timeline_get", {
    dependencies: [TeachingRecordingLearning],
    description:
      "Read one bounded page of a claimed Teaching Recording's semantic timeline. Actions include before, after, appeared, and disappeared accessibility evidence. Navigation observations and keyframes carry capture:transitional: destination rendering was not verified. A keyframe's url is its own capture URL. Missing capture metadata, including in older recordings, does not prove readiness. Instructions and URL transitions stay in order. Keyframes carry references, never bytes. Follow nextCursor until it is null.",
    failure: TeachingRecordingFailure,
    parameters: Schema.Struct({
      claimOperationId: OperationId,
      cursor: Schema.optional(
        Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
      ),
      recordingId: TeachingRecordingId,
    }),
    success: Schema.Unknown.pipe(Schema.decodeTo(TeachingTimeline)).annotate({
      description:
        "A bounded TeachingTimeline page with ordered entries, including reviewed instruction attachments, recordingId, maxCharacters, and nextCursor.",
    }),
  })
);

const TeachingKeyframeGetTool = readOnly(
  Tool.make("agent_teaching_keyframe_get", {
    dependencies: [TeachingRecordingLearning],
    description:
      "Get the local PNG file for one keyframe of a claimed Teaching Recording by the id returned in its semantic timeline. Open the returned path with your file tools. The path remains valid while the Teaching Recording is retained; verification or discard removes it. The timeline does not embed images or expose local artifact paths.",
    failure: TeachingRecordingFailure,
    parameters: Schema.Struct({
      claimOperationId: OperationId,
      keyframeId: Schema.String.check(Schema.isMinLength(1)),
      recordingId: TeachingRecordingId,
    }),
    success: TeachingKeyframeFile,
  })
);

const FlowSkillSaveTool = Tool.make("agent_flow_skill_save", {
  dependencies: [TeachingRecordingLearning],
  description:
    'Atomically save a proposed Flow Skill package for the claimed Teaching Recording. The same claim operation id saves again after a failed Dry Run or a rejection, which replaces the package and returns the recording to skill-drafted. A save is refused while a Dry Run is running, and after a passing Dry Run until the user rejects or verifies the flow. SKILL.md needs YAML frontmatter whose name matches the Flow Skill, a description, every {{placeholder}} declared under inputs as a bare name or as a `- name: <input>` mapping with an optional indented `description:` line, and a "Done when:" line on each numbered step. Optional files under references/ must be reachable from a link. A refusal returns one diagnostic per broken property and leaves any previous package unchanged.',
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    claimOperationId: OperationId,
    files: Schema.Array(FlowSkillFile),
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: FlowSkillSaveResult,
});

const DryRunInput = Schema.Union([
  Schema.Struct({
    changed: Schema.Boolean,
    name: Schema.String.check(Schema.isMinLength(1)),
    secret: Schema.Literal(false),
    value: Schema.String,
  }),
  Schema.Struct({
    changed: Schema.Boolean,
    name: Schema.String.check(Schema.isMinLength(1)),
    secret: Schema.Literal(true),
  }),
]);

const FlowSkillDryRunStartTool = Tool.make("agent_flow_skill_dry_run_start", {
  dependencies: [
    AgentSession,
    FileSystem.FileSystem,
    TeachingRecordingStore,
    FlowSkillCatalog,
  ],
  description:
    "Start a saved Flow Skill in a fresh context with Teaching Emulation. Follow nextAction. The saved skill outcome is the requested task; explore, recover, or choose another route within Teaching hosts. Pass explicitly user-requested verified skill names in prerequisites and their declared ordinary inputs in prerequisiteInputs, scoped by flowSkillName and name. All ordinary prerequisite inputs are fixed at startup. The result includes prerequisite procedures; they share this fresh context without widening Teaching hosts or replacing its outcome. Request prerequisite private Variables on demand with agent_variable_request; the user supplies or refuses them in Workspace. Changes to prerequisites or ordinary inputs require a fresh Dry Run. Ask for ordinary inputs again. For a secret input, pass its name with secret:true and no value; the user supplies its value in the returned Workspace when needed. Request or replace a declared tested-skill secret during this same Dry Run with agent_variable_request; its existing Workspace field reopens on replace:true and no Pending Decision is created. New input declarations require a revised package and fresh Dry Run. The Variable name for agent_variable_enter is the input name uppercased with underscores preserved (password becomes PASSWORD); invalid names or collisions are refused. Mark changed inputs when the task permits it. Report the complete skill outcome with agent_run_assess, explanation, Run-owned evidence, and explicit outcomeComplete. A partial attempt or any user Takeover cannot pass. Assessments and findings leave the browser open; agent_run_complete seals the report. A passing report requires Workspace user verification before Cleanup. It has no wall-clock limit.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    inputs: Schema.Array(DryRunInput),
    operationId: OperationId,
    prerequisiteInputs: optionalNullable(Schema.Array(AgentRunTaskInput)),
    prerequisites: optionalNullable(Schema.Array(FlowSkillName)),
    recordingId: TeachingRecordingId,
    url: Schema.String.check(Schema.isMinLength(1)),
    view: sessionViewParameter,
  }),
  success: Schema.Struct({
    ...WorkspaceLinkGuidance.fields,
    files: Schema.Array(FlowSkillFile),
    flowSkillName: FlowSkillName,
    prerequisites: Schema.Array(
      Schema.Struct({
        files: Schema.Array(FlowSkillFile),
        flowSkillName: FlowSkillName,
      })
    ),
    recordingId: TeachingRecordingId,
    session: UnpublishedSession,
    skillPath: Schema.String.check(Schema.isMinLength(1)),
  }),
});

const FlowSkillDecideTool = Tool.make("agent_flow_skill_decide", {
  dependencies: [AgentSession, TeachingRecordingStore],
  description:
    'Relay the user\'s explicit choice about a Flow Skill whose Dry Run passed. `decision:"verify"` keeps the flow: verification marks cleanup purge-pending before deleting the raw Teaching artifacts, and it ends the learning claim. `decision:"reject"` returns the Flow Skill to drafted with every Teaching artifact and the learning claim intact, so agent_flow_skill_save under the same claim operation id can edit the package for another Dry Run. Never send either without the user\'s explicit choice. `decision:"retry-cleanup"` is not a user choice: it resumes deletion for an already verified Flow Skill whose cleanup is still purge-pending, and the verified Flow Skill is never rolled back when deletion fails.',
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    decision: Schema.Literals(["verify", "reject", "retry-cleanup"]),
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: PublishedRecordingSummary,
});

export const TeachingRecordingTools = withStrictParameters(
  Toolkit.make(
    TeachingRecordingsListTool,
    TeachingRecordingClaimTool,
    TeachingTimelineGetTool,
    TeachingKeyframeGetTool,
    FlowSkillSaveTool,
    FlowSkillDryRunStartTool,
    FlowSkillDecideTool
  )
);

export const TeachingRecordingToolHandlersLive = TeachingRecordingTools.toLayer(
  {
    agent_flow_skill_decide: (params) =>
      decideFlowSkill(params).pipe(
        fromAgent,
        Effect.mapError(failure),
        Effect.flatMap(summaryOf)
      ),
    agent_flow_skill_dry_run_start: (params) =>
      Effect.gen(function* startFlowSkillDryRun() {
        const started = yield* startDryRun({
          inputs: params.inputs,
          operationId: params.operationId,
          prerequisiteInputs: params.prerequisiteInputs ?? [],
          prerequisites: params.prerequisites ?? [],
          recordingId: params.recordingId,
          url: params.url,
        }).pipe(Effect.mapError(failure));
        return {
          ...workspaceLinkGuidance(started.session.viewUrl),
          files: started.files,
          flowSkillName: started.manifest.flowSkillName,
          prerequisites: started.prerequisites,
          recordingId: started.manifest.recordingId,
          session: yield* encodeUnpublishedSession(
            params.view === "compact"
              ? compactAgentSession(started.session)
              : started.session
          ),
          skillPath: started.skillPath,
        };
      }),
    agent_flow_skill_save: (params) =>
      Effect.gen(function* saveFlowSkill() {
        const learning = yield* TeachingRecordingLearning;
        return yield* learning.save(params).pipe(Effect.mapError(failure));
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
      Effect.gen(function* moveTeachingClaim() {
        const store = yield* TeachingRecordingStore;
        if (params.action === "take") {
          const manifest = yield* store
            .startLearning({
              operationId: params.operationId,
              recordingId: params.recordingId,
            })
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
            claim: {
              claimedAt: manifest.lifecycle.claim.claimedAt,
              flowSkillName: manifest.flowSkillName,
              operationId: manifest.lifecycle.claim.operationId,
              recordingId: manifest.recordingId,
            },
            recording: yield* summaryOf(manifest),
          };
        }
        const claimOperationId = params.claimOperationId ?? undefined;
        if (claimOperationId === undefined) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_invalid",
              diagnostics: [],
              message: `Ending a learning claim on Teaching Recording ${params.recordingId} needs the claimOperationId it was taken with. (teaching_recording_invalid)`,
            })
          );
        }
        if (params.action === "release") {
          const released = yield* store
            .releaseLearning({
              claimOperationId,
              operationId: params.operationId,
              recordingId: params.recordingId,
            })
            .pipe(Effect.mapError(failure));
          return { claim: null, recording: yield* summaryOf(released) };
        }
        const error = params.error?.trim() ?? "";
        if (error.length === 0) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_invalid",
              diagnostics: [],
              message: `Failing Teaching Recording ${params.recordingId} needs a non-empty error saying why this process could not learn it. (teaching_recording_invalid)`,
            })
          );
        }
        const failed = yield* store
          .failLearning({
            claimOperationId,
            error,
            operationId: params.operationId,
            recordingId: params.recordingId,
          })
          .pipe(Effect.mapError(failure));
        return { claim: null, recording: yield* summaryOf(failed) };
      }),
    agent_teaching_recordings_list: (params) =>
      Effect.gen(function* listTeachingRecordings() {
        const learning = yield* TeachingRecordingLearning;
        const recordings = yield* learning
          .list()
          .pipe(Effect.mapError(failure));
        const selected =
          params.recordingId === undefined || params.recordingId === null
            ? recordings
            : recordings.filter(
                (recording) => recording.recordingId === params.recordingId
              );
        return { recordings: yield* Effect.all(selected.map(publishSummary)) };
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
