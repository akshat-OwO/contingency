import { createHash } from "node:crypto";
import path from "node:path";

import {
  AgentSessionSnapshot,
  AgentRunId,
  FlowSkillName,
  FlowSkillDiagnostic,
  FlowSkillFile,
  FlowSkillSaveResult,
  OperationId,
  TEACHING_RECORDING_WAIT_MAX_MS,
  TeachingKeyframeFile,
  TeachingRecordingClaimResult,
  TeachingRecordingId,
  TeachingRecordingList,
  TeachingRecordingSummary,
  TeachingTimeline,
} from "@contingency/protocol";
import type {
  AgentRunState,
  AgentRunStep,
  TeachingRecordingManifest,
} from "@contingency/protocol";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import { AgentRunStore } from "./agent-run-store.ts";
import { AgentSession } from "./agent-session.ts";
import {
  flowSkillProcedureSteps,
  readFlowSkillFrontmatter,
} from "./flow-skill-package.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { webHost } from "./teaching-demonstration.ts";
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

const TeachingRecordingsListTool = Tool.make("agent_teaching_recordings_list", {
  dependencies: [TeachingRecordingLearning],
  description:
    "List process-independent Teaching Recordings that an agent can claim for Flow Skill learning. Recordings created by contingency web appear after Stop, even when this MCP process did not create their browser session. Name a recordingId to answer with that one recording instead, waiting up to timeoutMs (default 30000, at most 60000) for it to reach its next durable state: recording, ready, learning, skill-drafted, dry-running, dry-run-failed, dry-run-passed, verified, or failed. The wait polls the durable manifest, so it works when another process owns the browser, and a recording that never arrives is refused with teaching_recording_timeout.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    recordingId: Schema.optional(Schema.NullOr(TeachingRecordingId)),
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
  success: TeachingRecordingList,
});

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
  success: TeachingRecordingClaimResult,
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
    "Get the local PNG file for one keyframe of a claimed Teaching Recording by the id returned in its semantic timeline. Open the returned path with your file tools. The path remains valid while the Teaching Recording is retained; verification or discard removes it. The timeline does not embed images or expose local artifact paths.",
  failure: TeachingRecordingFailure,
  parameters: Schema.Struct({
    claimOperationId: OperationId,
    keyframeId: Schema.String.check(Schema.isMinLength(1)),
    recordingId: TeachingRecordingId,
  }),
  success: TeachingKeyframeFile,
});

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
    AgentRunStore,
    FileSystem.FileSystem,
    TeachingRecordingStore,
  ],
  description:
    "Start a saved Flow Skill in a fresh browser context with the Teaching Recording's Emulation. Its numbered procedure becomes ordered Agent Steps. Ask for ordinary inputs again. For a secret input, pass its name with secret:true and no value; the user supplies its value in the returned Workspace. The Variable name for agent_variable_enter is the input name uppercased with underscores preserved (password becomes PASSWORD); invalid names or collisions are refused. Mark changed inputs when the task permits it. Assess each Step against its Done when line with agent_run_step_assess. The Dry Run ends and its result is derived when the last Step is assessed or a terminal assessment, ceiling, or agent_run_complete ends it.",
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
  success: TeachingRecordingSummary,
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
      Effect.gen(function* decideFlowSkill() {
        const store = yield* TeachingRecordingStore;
        const sessions = yield* AgentSession;
        const mutation = {
          operationId: params.operationId,
          recordingId: params.recordingId,
        };
        if (params.decision === "reject") {
          const rejected = yield* store
            .reject(mutation)
            .pipe(Effect.mapError(failure));
          yield* sessions.get(rejected.sessionId).pipe(Effect.ignore);
          return summaryOf(rejected);
        }
        /*
          Verifying purges in two durable halves: the verified transition lands
          first, then deletion runs. A retry re-enters only the second half,
          which is why a failed deletion never rolls the Flow Skill back.
        */
        if (params.decision === "verify") {
          yield* store.verify(mutation).pipe(Effect.mapError(failure));
        }
        const cleaned = yield* store
          .cleanup(mutation)
          .pipe(Effect.mapError(failure));
        yield* sessions.get(cleaned.sessionId).pipe(Effect.ignore);
        return summaryOf(cleaned);
      }),
    agent_flow_skill_dry_run_start: (params) =>
      // Start, persistence, and replay share one receipt and one session identity.
      // oxlint-disable-next-line eslint/complexity
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
        if (!("skillPath" in manifest.lifecycle)) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_conflict",
              diagnostics: [],
              message:
                "The Teaching Recording has no saved Flow Skill package. (teaching_recording_conflict)",
            })
          );
        }
        const skillPath = path.join(
          path.dirname(path.dirname(store.directory(manifest.recordingId))),
          manifest.lifecycle.skillPath
        );
        const skillContent = yield* fileSystem.readFileString(skillPath).pipe(
          Effect.mapError(
            (cause) =>
              new TeachingRecordingFailure({
                code: "teaching_recording_io",
                diagnostics: [],
                message: `Could not read the Flow Skill package: ${cause.message} (teaching_recording_io)`,
              })
          )
        );
        const frontmatter = readFlowSkillFrontmatter(skillContent);
        const declared = frontmatter?.inputs ?? [];
        const procedure = flowSkillProcedureSteps(skillContent);
        if (procedure.length === 0) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_invalid",
              diagnostics: [],
              message:
                "The Flow Skill has no numbered steps to assess. (teaching_recording_invalid)",
            })
          );
        }
        const host = webHost(params.url);
        const hosts = frontmatter?.hosts ?? [];
        if (host === undefined || !hosts.includes(host)) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_invalid",
              diagnostics: [],
              message: `The Dry Run must start on one of the Teaching Recording's visited hosts: ${hosts.join(", ")}. (teaching_recording_invalid)`,
            })
          );
        }
        const names = new Set(params.inputs.map((input) => input.name));
        if (
          names.size !== params.inputs.length ||
          names.size !== declared.length ||
          declared.some((input) => !names.has(input.name))
        ) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_invalid",
              diagnostics: [],
              message:
                "Dry Run inputs must name every declared Flow Skill input exactly once. (teaching_recording_invalid)",
            })
          );
        }
        const secretNames = params.inputs.flatMap((input) =>
          input.secret ? [input.name.toUpperCase()] : []
        );
        if (
          secretNames.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name)) ||
          new Set(secretNames).size !== secretNames.length
        ) {
          return yield* Effect.fail(
            new TeachingRecordingFailure({
              code: "teaching_recording_invalid",
              diagnostics: [],
              message:
                "Secret input names must map uniquely to uppercase Variable names. (teaching_recording_invalid)",
            })
          );
        }
        /*
          A secret input is named and never valued: the Dry Run session
          snapshot reaches the Workspace, so the literal stops here (ADR 0039).
        */
        const dryRunInputs = params.inputs.map((input) => ({
          changed: input.changed,
          name: input.name,
          value: input.secret ? null : input.value,
        }));
        const defaults = yield* (yield* AgentRunStore)
          .ceilings()
          .pipe(Effect.mapError(sessionFailure));
        const startedAt = new Date().toISOString();
        const steps: readonly AgentRunStep[] = procedure.map((step) => ({
          assessment: null,
          attempts: 0,
          confirmation: false,
          description: step.description,
          doneWhen: step.doneWhen,
          endedAt: null,
          execution: "pending",
          index: step.index,
          name: step.name,
          startedAt: null,
        }));
        const run: AgentRunState = {
          activeStepIndex: null,
          assessmentCounts: {
            blocked: 0,
            inconclusive: 0,
            notWorking: 0,
            working: 0,
          },
          attribution: {
            clientName: "flow-skill-dry-run",
            clientVersion: "1",
            reportedMetadataVerified: false,
            reportedModel: null,
            reportedProvider: null,
          },
          ceilings: {
            extensions: 0,
            runMs: defaults.runMs,
            stepMs: defaults.stepMs,
          },
          coverage: {
            complete: false,
            executed: 0,
            total: steps.length,
            unexecuted: steps.length,
          },
          endedAt: null,
          flowSkillName: manifest.flowSkillName,
          inputs: dryRunInputs.map(({ name, value }) => ({
            name,
            value: value ?? "<redacted>",
          })),
          outcome: null,
          runDeadline: startedAt,
          runId: AgentRunId.make(
            `agentrun-${createHash("sha256")
              .update(`${params.recordingId}:${params.operationId}`)
              .digest("hex")
              .slice(0, 32)}`
          ),
          startedAt,
          stepDeadline: null,
          steps,
          title: manifest.flowSkillName,
          variables: [],
        };
        const evidenceDirectory = path.join(
          store.directory(manifest.recordingId),
          "dry-run"
        );
        if (!replay) {
          yield* fileSystem
            .remove(evidenceDirectory, { force: true, recursive: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new TeachingRecordingFailure({
                    code: "teaching_recording_io",
                    diagnostics: [],
                    message: `Could not replace the previous Dry Run evidence: ${cause.message} (teaching_recording_io)`,
                  })
              )
            );
        }
        const session = yield* sessions
          .start({
            activity: "run",
            artifactDirectory: evidenceDirectory,
            clientName: "flow-skill-dry-run",
            clientVersion: "1",
            domainScope: { hosts },
            dryRun: {
              flowSkillName: manifest.flowSkillName,
              inputs: dryRunInputs,
              recordingId: manifest.recordingId,
              variables: secretNames.map((name) => ({
                name,
                runtime: true,
                secret: true,
                supplied: false,
              })),
            },
            emulation: manifest.emulation,
            operationId: params.operationId,
            run,
            url: params.url,
            viewport: manifest.emulation.viewport,
          })
          .pipe(Effect.mapError(sessionFailure));
        const started = yield* store
          .startDryRun({
            inputs: dryRunInputs,
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
        if (
          !("skillPath" in started.lifecycle) ||
          (started.lifecycle._tag !== "dry-running" && !replay)
        ) {
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
        if (!replay) {
          yield* Effect.forkDetach(
            Effect.sleep("1 second").pipe(
              Effect.andThen(store.read(params.recordingId)),
              Effect.map((current) => current.lifecycle._tag !== "dry-running"),
              Effect.catchCause(() => Effect.succeed(true)),
              Effect.repeat({ until: (ended: boolean) => ended }),
              Effect.andThen(
                sessions.completeRun(session.id).pipe(Effect.ignore)
              )
            )
          );
        }
        return {
          files,
          flowSkillName: started.flowSkillName,
          recordingId: started.recordingId,
          session,
          skillPath: started.lifecycle.skillPath,
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
            recording: summaryOf(manifest),
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
          return { claim: null, recording: summaryOf(released) };
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
        return { claim: null, recording: summaryOf(failed) };
      }),
    agent_teaching_recordings_list: (params) =>
      Effect.gen(function* listTeachingRecordings() {
        const learning = yield* TeachingRecordingLearning;
        /*
          A named recording is the waiting form. `wait` answers as soon as the
          recording holds a durable learning state, so a zero timeout reads one
          recording and a longer one blocks until that state arrives.
        */
        if (params.recordingId !== undefined && params.recordingId !== null) {
          const summary = yield* learning
            .wait(params.recordingId, params.timeoutMs ?? 30_000)
            .pipe(Effect.mapError(failure));
          return { recordings: [summary] };
        }
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
