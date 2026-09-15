import {
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
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

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
  message: Schema.String,
}) {}

const failure = (
  cause: TeachingRecordingLearningError | TeachingRecordingStoreError
) =>
  new TeachingRecordingFailure({
    code: cause.code,
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
    lifecycle._tag !== "failed"
  ) {
    throw new Error(
      `Teaching Recording ${manifest.recordingId} has no learning-agent state.`
    );
  }
  return {
    failure: lifecycle._tag === "failed" ? lifecycle.error : null,
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
    "Wait for a named Teaching Recording to enter recording, ready, learning, or failed. The tool polls its durable manifest, so it works when another process owns the browser. The timeout is at most 60000 ms.",
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
    "Claim one ready Teaching Recording for Flow Skill learning. The durable claim is exclusive across processes. An abandoned claim returns to ready after its owner exits. Replay the same operation id to reread the claim.",
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
    "Atomically save a proposed Flow Skill package for the claimed Teaching Recording. Supply a non-empty SKILL.md and optional non-empty files under references/. Invalid paths and failed writes leave any previous package unchanged.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    claimOperationId: OperationId,
    files: Schema.Array(FlowSkillFile),
    operationId: OperationId,
    recordingId: TeachingRecordingId,
  }),
  success: FlowSkillSaveResult,
});

const TeachingRecordingReleaseTool = Tool.make(
  "agent_teaching_recording_release",
  {
    dependencies: [TeachingRecordingStore],
    description:
      "Release this process's learning claim and return the Teaching Recording to ready for another attempt. Supply the original claim operation id and a fresh mutation operation id.",
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
    TeachingRecordingReleaseTool,
    TeachingRecordingFailTool
  )
);

export const TeachingRecordingToolHandlersLive = TeachingRecordingTools.toLayer(
  {
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
