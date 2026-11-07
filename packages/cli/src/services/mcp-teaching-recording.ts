import {
  isLiveAgentSessionPhase,
  Variable,
  AgentRunTaskInput,
  FlowName,
  FlowDiagnostic,
  FlowFile,
  FlowSaveResult,
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
import { Tool, Toolkit } from "effect/ai";

import { isFlowInActiveRun } from "./active-flow-runs.ts";
import type { AgentSessionError } from "./agent-session.ts";
import { AgentSession } from "./agent-session.ts";
import { FlowCatalog } from "./flow-catalog.ts";
import { flowDocuments, SupportingDocument } from "./flow-documents.ts";
import {
  UnpublishedEmulation,
  UnpublishedRuntimeRequirements,
  UnpublishedSession,
  WorkspaceLinkGuidance,
  encodeUnpublishedEmulation,
  encodeUnpublishedRuntimeRequirements,
  encodeUnpublishedSession,
  sessionViewParameter,
  sessionInView,
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
  decideFlow,
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
  diagnostics: Schema.Array(FlowDiagnostic),
  message: Schema.String,
}) {}

const failure = (
  cause:
    | AgentSessionError
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
 * A recording summary as the catalog publishes it. Its Emulation and runtime requirements are the
 * protocol shape, encoded but not republished in each tool that answers with
 * a summary (ADR 0045).
 */
const PublishedRecordingSummary = Schema.Struct({
  ...TeachingRecordingSummary.fields,
  emulation: Schema.NullOr(UnpublishedEmulation),
  runtime: Schema.optionalKey(UnpublishedRuntimeRequirements),
});

const PublishedRecordingList = Schema.Struct({
  recordings: Schema.Array(PublishedRecordingSummary),
});

const PublishedClaimResult = Schema.Struct({
  claim: Schema.NullOr(TeachingRecordingClaim),
  recording: PublishedRecordingSummary,
});

const publishSummary = (summary: TeachingRecordingSummary) =>
  Effect.gen(function* publishRecordingSummary() {
    const emulation =
      summary.emulation === null
        ? null
        : yield* encodeUnpublishedEmulation(summary.emulation);
    if (summary.runtime === undefined) {
      return { ...summary, emulation };
    }
    const runtime = yield* encodeUnpublishedRuntimeRequirements(
      summary.runtime
    );
    return { ...summary, emulation, runtime };
  });

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
      "List process-independent Teaching Recordings for Flow learning. Name recordingId to filter one recording. Returns immediately. For a session owned by this MCP process, wait with agent_session_get. Otherwise retry the same recordingId about once per second while the list is empty or its lifecycle is recording. Learn when ready; inspect failed capture errors. Stop retrying if the user cancels.",
    failure: TeachingRecordingFailure,
    parameters: Schema.Struct({
      recordingId: Schema.optional(Schema.NullOr(TeachingRecordingId)),
    }),
    success: PublishedRecordingList,
  })
);

const TeachingRecordingDiscardTool = Tool.make(
  "agent_teaching_recording_discard",
  {
    dependencies: [AgentSession, TeachingRecordingStore],
    description:
      "Delete a stopped Teaching Recording's retained artifacts after the run completes. Release any learning claim first with agent_teaching_recording_claim. Ask the user first. Call only after the user confirms deletion.",
    failure: TeachingRecordingFailure,
    parameters: Schema.Struct({
      operationId: OperationId,
      recordingId: TeachingRecordingId,
      userConfirmed: Schema.Literal(true),
    }),
    success: Schema.Struct({ discarded: Schema.Boolean }),
  }
);

const TeachingRecordingClaimTool = Tool.make("agent_teaching_recording_claim", {
  dependencies: [TeachingRecordingStore],
  description:
    'Move this process\'s learning claim on one Teaching Recording. `action:"take"` claims a ready recording and answers with the claim; the durable claim is exclusive across processes and lasts through saving, Dry Runs, and a rejection. `action:"release"` ends the claim and returns the recording to ready for another attempt, from any claimed state including a drafted or dry-run-failed Flow. `action:"fail"` ends the claim and records `error`, why this process could not learn the Flow; the failed recording stays discoverable and accepts a later claim. Release and fail need the original claimOperationId beside a fresh operationId; take needs only its own operationId, and replaying it rereads the same claim. An abandoned claim returns to ready after its owner exits.',
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
      "Read one bounded page of a claimed Teaching Recording's semantic timeline. Actions include before, after, appeared, and disappeared accessibility evidence. Navigation observations and keyframes carry capture:transitional: destination rendering was not verified. A keyframe's url is its own capture URL. Missing capture metadata, including in older recordings, does not prove readiness. Instructions and URL transitions stay in order. In a Guided Run, user Takeover actions and answers outrank the agent's reading of the Source Document wherever they disagree. Keyframes carry references, never bytes. Follow nextCursor until it is null.",
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

const FlowSaveTool = Tool.make("agent_flow_save", {
  dependencies: [
    TeachingRecordingLearning,
    TeachingRecordingStore,
    AgentSession,
  ],
  description:
    'Atomically save a proposed Flow package for the claimed Teaching Recording. The same claim operation id saves again after a failed Dry Run or a rejection, which replaces the package and returns the recording to flow-drafted. A save is refused while any active Run uses this Flow, while a Dry Run is running, and after a passing Dry Run until the user rejects or verifies the flow. flow.md needs YAML frontmatter whose name matches the Flow, a description, every {{placeholder}} declared under inputs as a bare name or as a `- name: <input>` mapping with an optional indented `description:` line, and a "Done when:" line on each numbered step. Supporting Markdown documents may live at any depth outside runs/ and recordings/. Link each supporting document from flow.md with a relative path. A refusal returns one diagnostic per broken property and leaves any previous package unchanged.',
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    claimOperationId: OperationId,
    files: Schema.Array(FlowFile),
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: FlowSaveResult,
});

const DryRunInput = Schema.Union([
  Schema.Struct({
    changed: Schema.Boolean,
    name: Schema.String.check(Schema.isMinLength(1)),
    secret: Variable.fields.secret,
    value: Schema.String,
  }),
  Schema.Struct({
    changed: Schema.Boolean,
    name: Schema.String.check(Schema.isMinLength(1)),
    secret: Variable.fields.secret,
  }),
]);

const FlowDryRunStartTool = Tool.make("agent_flow_dry_run_start", {
  dependencies: [
    AgentSession,
    FileSystem.FileSystem,
    TeachingRecordingStore,
    FlowCatalog,
  ],
  description:
    "Start a saved Flow in a fresh context with Teaching Emulation. Follow nextAction. The saved flow outcome is the requested task; explore, recover, or choose another route within Teaching hosts. Pass explicitly user-requested verified flow names in prerequisites and their declared ordinary inputs in prerequisiteInputs, scoped by flowName and name. All ordinary prerequisite inputs are fixed at startup. The result includes prerequisite procedures; they share this fresh context without widening Teaching hosts or replacing its outcome. Request prerequisite Variables on demand with agent_variable_request; the user supplies or refuses them in Workspace. Changes to prerequisites or ordinary inputs require a fresh Dry Run. Ask for ordinary inputs again. For an on-demand input, omit its value; the user supplies its value in the returned Workspace when needed. Request or replace a declared tested-flow on-demand Variable during this same Dry Run with agent_variable_request; its existing Workspace field reopens on replace:true and no Pending Decision is created. New input declarations require a revised package and fresh Dry Run. The Variable name for agent_variable_enter is the input name uppercased with underscores preserved (password becomes PASSWORD); invalid names or collisions are refused. Mark changed inputs when the task permits it. Report the complete flow outcome with agent_run_assess, explanation, Run-owned evidence, and explicit outcomeComplete. A partial attempt or any user Takeover cannot pass. Assessments and findings leave the browser open; agent_run_complete seals the report. A passing report requires Workspace user verification before Cleanup. It has no wall-clock limit.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    inputs: Schema.Array(DryRunInput),
    operationId: OperationId,
    prerequisiteInputs: optionalNullable(Schema.Array(AgentRunTaskInput)),
    prerequisites: optionalNullable(Schema.Array(FlowName)),
    recordingId: TeachingRecordingId,
    url: Schema.String.check(Schema.isMinLength(1)),
    view: sessionViewParameter,
  }),
  success: Schema.Struct({
    ...WorkspaceLinkGuidance.fields,
    files: Schema.Array(FlowFile),
    flowName: FlowName,
    flowPath: Schema.String.check(Schema.isMinLength(1)),
    prerequisites: Schema.Array(
      Schema.Struct({
        files: Schema.Array(FlowFile),
        flowName: FlowName,
        supportingDocuments: Schema.Array(SupportingDocument),
      })
    ),
    recordingId: TeachingRecordingId,
    session: UnpublishedSession,
    supportingDocuments: Schema.Array(SupportingDocument),
  }),
});

const FlowDecideTool = Tool.make("agent_flow_decide", {
  dependencies: [AgentSession, TeachingRecordingStore],
  description:
    'Relay the user\'s explicit choice about a Flow whose Dry Run passed. `decision:"verify"` keeps the flow: verification marks cleanup purge-pending before deleting the raw Teaching artifacts, and it ends the learning claim. `decision:"reject"` returns the Flow to drafted with every Teaching artifact and the learning claim intact, so agent_flow_save under the same claim operation id can edit the package for another Dry Run. Never send either without the user\'s explicit choice. `decision:"retry-cleanup"` is not a user choice: it resumes deletion for an already verified Flow whose cleanup is still purge-pending, and the verified Flow is never rolled back when deletion fails.',
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
    TeachingRecordingDiscardTool,
    TeachingRecordingClaimTool,
    TeachingTimelineGetTool,
    TeachingKeyframeGetTool,
    FlowSaveTool,
    FlowDryRunStartTool,
    FlowDecideTool
  )
);

/** Relay confirmed deletion through the live owner's complete discard operation. */
export const discardTeachingRecording = Effect.fn(
  "Mcp.discardTeachingRecording"
)(function* discardTeachingRecording(params: {
  recordingId: TeachingRecordingId;
  operationId: OperationId;
}) {
  const sessions = yield* AgentSession;
  const owner = (yield* sessions.list()).find(
    (session) =>
      session.activity === "teaching" &&
      session.recordingId === params.recordingId &&
      isLiveAgentSessionPhase(session.phase)
  );
  if (owner === undefined) {
    const store = yield* TeachingRecordingStore;
    yield* store.discard(params);
  } else {
    yield* sessions.discardTeachingRecording(owner.id, params.operationId);
  }
  return { discarded: true };
});

export const TeachingRecordingToolHandlersLive = TeachingRecordingTools.toLayer(
  {
    agent_flow_decide: (params) =>
      decideFlow(params).pipe(
        fromAgent,
        Effect.mapError(failure),
        Effect.flatMap(summaryOf)
      ),
    agent_flow_dry_run_start: (params) =>
      Effect.gen(function* startFlowDryRun() {
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
          ...flowDocuments(started.files),
          flowName: started.manifest.flowName,
          flowPath: started.flowPath,
          prerequisites: started.prerequisites.map((flow) => ({
            flowName: flow.flowName,
            ...flowDocuments(flow.files),
          })),
          recordingId: started.manifest.recordingId,
          session: yield* encodeUnpublishedSession(
            sessionInView(started.session, params.view)
          ),
        };
      }),
    agent_flow_save: (params) =>
      Effect.gen(function* saveFlow() {
        const learning = yield* TeachingRecordingLearning;
        const store = yield* TeachingRecordingStore;
        const manifest = yield* store
          .read(params.recordingId)
          .pipe(Effect.mapError(failure));
        if (yield* isFlowInActiveRun(manifest.flowName)) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_conflict",
              diagnostics: [],
              message:
                "An active Run uses this Flow. Propose changes with agent_run_finding; save only after the Run ends.",
            })
          );
        }
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
              flowName: manifest.flowName,
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
    agent_teaching_recording_discard: (params) =>
      discardTeachingRecording(params).pipe(Effect.mapError(failure)),
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
