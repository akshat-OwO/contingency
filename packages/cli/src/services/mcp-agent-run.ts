import { randomUUID } from "node:crypto";

import {
  AgentRunComplete,
  AgentRunId,
  AgentRunOpen,
  AgentRunSummary,
  FlowSkillRunStart,
  AgentTaskRunStart,
  AgentRunTaskInput,
  AgentTaskAssessment,
  FlowSkillName,
  OperationId,
  AgentSessionId,
  optionalNullable,
} from "@contingency/protocol";
import type {
  AgentRunSkillReference,
  TaskAgentRunState,
} from "@contingency/protocol";
import { Effect, Layer, Option, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import type { Mutable } from "effect/Types";

import { AgentRunStore } from "./agent-run-store.ts";
import { AgentSession } from "./agent-session.ts";
import { requestedBrowserChecks } from "./browser-check-requirements.ts";
import { markDemoWork } from "./demo-site.ts";
import { webHost } from "./domain-scope.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import type { FlowSkillPackage } from "./flow-skill-catalog.ts";
import {
  SessionResult,
  SessionStartResult,
  UnpublishedRunSummary,
  encodeUnpublishedRunSummary,
  inStartView,
  inView,
  sessionViewParameter,
} from "./mcp-session-output.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";
import { makeVerificationElicitation } from "./mcp-verification-elicitation.ts";
import { readExampleSkills } from "./onboarding-examples.ts";
import {
  readRequestedSkills,
  taskVariables,
  validateTaskInputs,
} from "./requested-flow-skills.ts";
import {
  startingRunEmulation,
  skillRunEmulation,
  emulationDifferences,
} from "./run-emulation.ts";
import { requestedScans } from "./scan-requirements.ts";
import { fromAgent } from "./session-events.ts";
import { TeachingRecordingStore } from "./teaching-recording-store.ts";

/** The failure an MCP client reads for Interactive Run tools. */
// `Schema.Error` is a class factory, not a thrown error: the rule's autofix
// would turn this extends clause into `new Schema.Error(...)`.
// oxlint-disable-next-line unicorn/throw-new-error
export class AgentRunFailure extends Schema.Error<AgentRunFailure>(
  "AgentRunFailure"
)({
  code: Schema.String,
  message: Schema.String,
}) {}

const failure = (cause: { readonly code: string; readonly message: string }) =>
  new AgentRunFailure({
    code: cause.code,
    message: `${cause.message} (${cause.code})`,
  });

const FlowSkillRunStartTool = Tool.make("agent_flow_skill_run_start", {
  dependencies: [AgentSession, FlowSkillCatalog, AgentRunStore],
  description:
    "Start one user-requested verified Flow Skill. Prefer agent_run_start for explicit tasks or multiple skills. Private inputs use Variables.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    clientName: FlowSkillRunStart.fields.clientName,
    clientVersion: FlowSkillRunStart.fields.clientVersion,
    flowSkillName: FlowSkillRunStart.fields.flowSkillName,
    inputs: FlowSkillRunStart.fields.inputs,
    operationId: FlowSkillRunStart.fields.operationId,
    reportedModel: FlowSkillRunStart.fields.reportedModel,
    reportedProvider: FlowSkillRunStart.fields.reportedProvider,
    url: FlowSkillRunStart.fields.url,
    view: sessionViewParameter,
  }),
  success: SessionStartResult,
});

const AgentRunCompleteTool = Tool.make("agent_run_complete", {
  dependencies: [AgentSession, TeachingRecordingStore],
  description:
    "Seal the Run's evidence and close its browser. Assessments alone leave it open. A Dry Run passes only with a working complete outcome, fulfilled required scans, and no Takeover. Ended Runs return the persisted Summary. Evidence remains local.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    agentAccount: AgentRunComplete.fields.agentAccount,
    operationId: AgentRunComplete.fields.operationId,
    sessionId: AgentRunComplete.fields.sessionId,
  }),
  success: AgentRunSummary,
});

const AgentRunOpenTool = readOnly(
  Tool.make("open_run", {
    dependencies: [AgentSession, AgentRunStore],
    description:
      "Open a new read-only local viewer for a persisted Run, including one recorded by an MCP process that has since exited. It reads the stored Run Summary and evidence and restores no browser state.",
    failure: AgentRunFailure,
    parameters: Schema.Struct({ runId: AgentRunOpen.fields.runId }),
    success: Schema.Struct({
      summary: UnpublishedRunSummary,
      /** Local, loopback, and read-only: no browser state is restored. */
      viewUrl: Schema.String.check(Schema.isMinLength(1)),
    }),
  })
);

const AgentTaskRunStartTool = Tool.make("agent_run_start", {
  dependencies: [AgentSession, FlowSkillCatalog, AgentRunStore],
  description:
    "Start a task in one browser context with user-requested verified skills and ordinary inputs. Follow nextAction. The agent owns its route. Use agent_run_update for changed instructions, skills, or inputs; request private Variables only when needed. Assessments and findings preserve the browser; agent_run_complete seals evidence. Fulfill applicable scanRequirements with agent_run_scan. Takeover and Execution Boundaries remain exclusive.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    ...AgentTaskRunStart.fields,
    view: sessionViewParameter,
  }),
  success: SessionStartResult,
});
const AgentTaskRunUpdateTool = Tool.make("agent_run_update", {
  dependencies: [AgentSession, FlowSkillCatalog],
  description:
    "Update the user instruction, requested verified skills, or ordinary inputs in the same Run. Browser state and starting Emulation persist. Inputs are skill-scoped; private inputs use agent_variable_request.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    inputs: Schema.Array(AgentRunTaskInput),
    instruction: optionalNullable(Schema.String.check(Schema.isMinLength(1))),
    operationId: OperationId,
    referencedSkills: Schema.Array(FlowSkillName),
    sessionId: AgentSessionId,
    view: sessionViewParameter,
  }),
  success: SessionResult,
});
const taskReportParameters = Schema.Struct({
  evidence: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1)),
      kind: Schema.Literals(["snapshot", "attempt", "artifact"]),
    }).annotate({
      message:
        'Evidence item needs {kind,id}: kind must be "snapshot", "attempt", or "artifact" and id must be a non-empty string',
    })
  ).check(Schema.isMinLength(1)),
  explanation: AgentTaskAssessment.fields.explanation,
  operationId: OperationId,
  outcome: AgentTaskAssessment.fields.outcome,
  outcomeComplete: optionalNullable(Schema.Boolean),
  sessionId: AgentSessionId,
  view: sessionViewParameter,
});
const taskReport = (
  params: typeof taskReportParameters.Type
): Omit<AgentTaskAssessment, "submittedAt"> => {
  const report = {
    evidence: params.evidence,
    explanation: params.explanation,
    outcome: params.outcome,
  };
  if (params.outcomeComplete === undefined) {
    // MCP structured results are JSON: omit absent fields instead of storing undefined.
    return report;
  }
  return { ...report, outcomeComplete: params.outcomeComplete };
};
const AgentTaskAssessTool = Tool.make("agent_run_assess", {
  dependencies: [AgentSession],
  description:
    'Record an evidence-backed model assessment of the requested task or complete Dry Run skill outcome. Cite Snapshot or attempt ids produced by this Run, as a non-empty array such as [{"kind":"snapshot","id":"snapshot-2"}] or [{"kind":"attempt","id":"action-123"}]. For a Dry Run, explicitly set outcomeComplete to whether the complete skill outcome was attempted; a partial attempt cannot pass. Every outcome leaves the browser open for exploration or recovery. When this is your final assessment, call agent_run_complete next. A passing Dry Run still needs the user\'s Workspace verification before Cleanup.',
  failure: AgentRunFailure,
  parameters: taskReportParameters,
  success: SessionResult,
});
const AgentTaskFindingTool = Tool.make("agent_run_finding", {
  dependencies: [AgentSession],
  description:
    "Append an evidence-backed finding without ending the Run or replacing its task assessment. Cite a Snapshot or attempt produced by this Run.",
  failure: AgentRunFailure,
  parameters: taskReportParameters,
  success: SessionResult,
});
const AgentRunScanTool = Tool.make("agent_run_scan", {
  dependencies: [AgentSession],
  description:
    "Start at the taught condition. Accessibility/reload return reports; navigation/timespan need stop. One scan per Run/tab, one automatic retry. Further retries must cite a newer user instruction's receivedAt. Cite reports as artifact evidence.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    action: Schema.Literals(["start", "stop"]),
    flowSkillName: FlowSkillName,
    operationId: OperationId,
    requirementId: Schema.String.check(Schema.isMinLength(1)),
    retryInstructionAt: optionalNullable(Schema.String),
    sessionId: AgentSessionId,
    view: sessionViewParameter,
  }),
  success: SessionResult,
});
const AgentRunScanScopeTool = Tool.make("agent_run_scan_scope", {
  dependencies: [AgentSession],
  description:
    "Mark a scan outside an explicitly partial user-requested journey, with a reason. Interactive Runs only; Dry Runs require all scans.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    flowSkillName: FlowSkillName,
    operationId: OperationId,
    reason: Schema.String.check(Schema.isMinLength(1)),
    requirementId: Schema.String.check(Schema.isMinLength(1)),
    sessionId: AgentSessionId,
    view: sessionViewParameter,
  }),
  success: SessionResult,
});

/** The Interactive Run surface. */
export const AgentRunTools = withStrictParameters(
  Toolkit.make(
    AgentRunScanTool,
    AgentRunScanScopeTool,
    FlowSkillRunStartTool,
    AgentRunCompleteTool,
    AgentRunOpenTool,
    AgentTaskRunStartTool,
    AgentTaskRunUpdateTool,
    AgentTaskAssessTool,
    AgentTaskFindingTool
  )
);

/**
 * How a Run resolves the skills it starts with. A catalog Run reads only
 * user-verified packages from the selected Catalog Root. An Example Run is
 * handed bundled Example Flow Skills explicitly and records their origin, so
 * neither path can pass for the other (ADR 0050).
 */
export type TaskRunSkills =
  | { readonly origin: "catalog" }
  | {
      readonly origin: "example";
      readonly skills: readonly FlowSkillPackage[];
    };

/** A skill reference that records a bundled Example's origin. */
const skillReference = (
  flowSkillName: FlowSkillName,
  referencedAt: string,
  origin: TaskRunSkills["origin"]
): AgentRunSkillReference => {
  const reference: Mutable<AgentRunSkillReference> = {
    flowSkillName,
    referencedAt,
  };
  if (origin === "example") {
    reference.origin = "example";
  }
  return reference;
};

export const startTaskRun = (
  params: AgentTaskRunStart,
  resolution: TaskRunSkills
) =>
  Effect.gen(function* openTaskRun() {
    const session = yield* AgentSession;
    const store = yield* AgentRunStore;
    const catalog = yield* FlowSkillCatalog;
    return yield* session
      .startPrepared(
        {
          operationId: params.operationId,
          request: JSON.stringify({
            activity: "task-run",
            ...params,
            origin: resolution.origin,
          }),
        },
        Effect.gen(function* prepareTaskRun() {
          const skills =
            resolution.origin === "example"
              ? resolution.skills
              : yield* readRequestedSkills(params.referencedSkills).pipe(
                  Effect.provideService(FlowSkillCatalog, catalog)
                );
          yield* validateTaskInputs(skills, params.inputs);
          const host = webHost(params.url);
          if (host === undefined) {
            return yield* Effect.fail(
              new AgentRunFailure({
                code: "flow_skill_invalid",
                message: "A task Run starts on an http or https page.",
              })
            );
          }
          const hosts = [...new Set(skills.flatMap((skill) => skill.hosts))];
          if (hosts.length === 0) {
            hosts.push(host);
          }
          if (!hosts.includes(host)) {
            return yield* Effect.fail(
              new AgentRunFailure({
                code: "flow_skill_invalid",
                message: `The requested skills were demonstrated on ${hosts.join(", ")}, so this Run cannot start on ${host}.`,
              })
            );
          }

          const { emulation, source } = yield* startingRunEmulation(skills);
          const runId = AgentRunId.make(`agentrun-${randomUUID()}`);
          const artifactDirectory = yield* store.prepare(runId);
          const startedAt = new Date().toISOString();
          const run: TaskAgentRunState = markDemoWork(hosts, {
            assessment: null,
            attribution: {
              clientName: params.clientName ?? "unknown",
              clientVersion: params.clientVersion ?? "unknown",
              reportedMetadataVerified: false,
              reportedModel: params.reportedModel ?? null,
              reportedProvider: params.reportedProvider ?? null,
            },
            browserChecks: yield* requestedBrowserChecks(skills),
            emulationSource:
              source === undefined
                ? { kind: "default" }
                : { flowSkillName: source, kind: "flow-skill" },
            findings: [],
            inputs: params.inputs,
            instructions: [],
            lastAgentActivityAt: startedAt,
            lifecycle: { phase: "running" },
            purpose: { kind: "interactive" },
            referencedSkills: skills.map((skill) =>
              skillReference(skill.name, startedAt, resolution.origin)
            ),
            requestedTask: params.requestedTask,
            runId,
            scanReports: [],
            scanRequirements: yield* requestedScans(skills),
            schemaVersion: 3,
            startedAt,
            startingEmulation: emulation,
            title: params.requestedTask,
            variables: skills.flatMap(taskVariables),
          });
          return {
            activity: "run" as const,
            artifactDirectory,
            clientName: params.clientName,
            clientVersion: params.clientVersion,
            domainScope: { hosts },
            emulation,
            run,
            url: params.url,
            viewport: emulation.viewport,
          };
        })
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof AgentRunFailure ? cause : failure(cause)
        )
      );
  });

const offerVerification = makeVerificationElicitation();

export const AgentRunToolHandlersLive = AgentRunTools.toLayer({
  agent_flow_skill_run_start: ({ view, ...params }) =>
    startTaskRun(
      {
        ...params,
        inputs: params.inputs.map((input) => ({
          ...input,
          flowSkillName: params.flowSkillName,
        })),
        referencedSkills: [params.flowSkillName],
        requestedTask: `Run Flow Skill ${params.flowSkillName}`,
      },
      { origin: "catalog" }
    ).pipe(inStartView(view)),
  agent_run_assess: (params) =>
    Effect.gen(function* assessTaskRun() {
      const session = yield* AgentSession;
      return yield* session
        .assessTask(
          params.sessionId,
          taskReport(params),
          false,
          params.operationId
        )
        .pipe(Effect.mapError(failure), inView(params.view));
    }),
  agent_run_complete: (params) =>
    Effect.gen(function* completeInteractiveRun() {
      const session = yield* AgentSession;
      yield* session.noteAgentActivity(params.sessionId);
      // The Run persisted its own Summary when it ended. Completing an already
      // ended Run answers with that same Summary rather than writing a second.
      const summary = yield* session
        .completeRun(params.sessionId, params.agentAccount, params.operationId)
        .pipe(fromAgent, Effect.mapError(failure));
      const snapshot = yield* session
        .get(params.sessionId)
        .pipe(Effect.mapError(failure));
      if (snapshot.dryRun !== null) {
        const store = yield* TeachingRecordingStore;
        const recording = yield* store
          .read(snapshot.dryRun.recordingId)
          .pipe(Effect.option);
        if (
          Option.isSome(recording) &&
          recording.value.lifecycle._tag === "dry-run-passed"
        ) {
          yield* offerVerification(params.sessionId, snapshot.viewUrl);
        }
      }
      return summary;
    }),
  agent_run_finding: (params) =>
    Effect.gen(function* recordTaskFinding() {
      const session = yield* AgentSession;
      return yield* session
        .assessTask(
          params.sessionId,
          taskReport(params),
          true,
          params.operationId
        )
        .pipe(Effect.mapError(failure), inView(params.view));
    }),
  agent_run_scan: (params) =>
    Effect.gen(function* scanRun() {
      const session = yield* AgentSession;
      return yield* session
        .scan(
          params.sessionId,
          params.flowSkillName,
          params.requirementId,
          params.action,
          params.operationId,
          params.retryInstructionAt ?? undefined
        )
        .pipe(Effect.mapError(failure), inView(params.view));
    }),
  agent_run_scan_scope: (params) =>
    Effect.gen(function* scopeScan() {
      const session = yield* AgentSession;
      return yield* session
        .scanScope(
          params.sessionId,
          params.flowSkillName,
          params.requirementId,
          params.reason,
          params.operationId
        )
        .pipe(Effect.mapError(failure), inView(params.view));
    }),
  agent_run_start: ({ view, ...params }) =>
    startTaskRun(params, { origin: "catalog" }).pipe(inStartView(view)),
  agent_run_update: ({ view, ...params }) =>
    Effect.gen(function* updateTaskRun() {
      const session = yield* AgentSession;
      const catalog = yield* FlowSkillCatalog;
      const prepare = Effect.gen(function* prepareTaskUpdate() {
        const snapshot = yield* session.get(params.sessionId);
        const { run } = snapshot;
        if (run === null || !("schemaVersion" in run)) {
          return yield* Effect.fail(
            new AgentRunFailure({
              code: "agent_session_invalid",
              message: "This session is not a task Run.",
            })
          );
        }
        const referenced = new Set([
          ...run.referencedSkills.map((skill) => skill.flowSkillName),
          ...params.referencedSkills,
        ]);
        if (
          params.inputs.some((input) => !referenced.has(input.flowSkillName))
        ) {
          return yield* Effect.fail(
            new AgentRunFailure({
              code: "flow_skill_invalid",
              message:
                "Task inputs must belong to a user-requested Flow Skill.",
            })
          );
        }
        // An Example Run keeps resolving its bundled skills from the bundle;
        // every other name is a user-verified catalog skill.
        const examples = new Set(
          run.referencedSkills.flatMap((skill) =>
            skill.origin === "example" ? [skill.flowSkillName] : []
          )
        );
        const names = [
          ...params.referencedSkills,
          ...params.inputs.map((input) => input.flowSkillName),
        ];
        const skills = [
          ...(yield* readExampleSkills(
            names.filter((name) => examples.has(name))
          ).pipe(Effect.provideService(FlowSkillCatalog, catalog))),
          ...(yield* readRequestedSkills(
            names.filter((name) => !examples.has(name))
          ).pipe(Effect.provideService(FlowSkillCatalog, catalog))),
        ];
        yield* validateTaskInputs(skills, params.inputs);
        const checks = yield* requestedBrowserChecks(skills);
        const scans = yield* requestedScans(skills);
        const requested = new Set(params.referencedSkills);
        const emulationConflicts = [];
        for (const skill of skills) {
          if (!requested.has(skill.name)) {
            continue;
          }
          const expected = yield* skillRunEmulation(skill);
          if (expected === undefined) {
            continue;
          }
          const differingFields = emulationDifferences(
            run.startingEmulation,
            expected
          );
          if (differingFields.length > 0) {
            emulationConflicts.push({
              differingFields,
              flowSkillName: skill.name,
              recovery: `The current browser keeps its starting emulation. Start a separate Run of ${skill.name} to reproduce its saved environment, or continue this composed task only where the differing environment is acceptable.`,
            });
          }
        }
        return {
          emulationConflicts,
          inputs: params.inputs,
          instruction: params.instruction,
          skills: skills.flatMap((skill) =>
            requested.has(skill.name)
              ? [
                  {
                    browserChecks: checks.filter(
                      (reference) => reference.flowSkillName === skill.name
                    ),
                    flowSkillName: skill.name,
                    hosts: skill.hosts,
                    scans: scans.filter(
                      (scan) => scan.flowSkillName === skill.name
                    ),
                    variables: taskVariables(skill),
                  },
                ]
              : []
          ),
        };
      });
      return yield* session
        .updateTask(
          params.sessionId,
          prepare,
          params.operationId,
          JSON.stringify(params)
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof AgentRunFailure ? cause : failure(cause)
          ),
          inView(view)
        );
    }),
  open_run: (params) =>
    Effect.gen(function* openPersistedRun() {
      const store = yield* AgentRunStore;
      const session = yield* AgentSession;
      const summary = yield* store
        .read(params.runId)
        .pipe(Effect.mapError(failure));
      const viewUrl = yield* session
        .runViewUrl(params.runId)
        .pipe(Effect.mapError(failure));
      return {
        summary: yield* encodeUnpublishedRunSummary(summary),
        viewUrl,
      };
    }),
});

/** MCP's typed Interactive Run surface. */
export const McpAgentRunLayer = McpServer.toolkit(AgentRunTools).pipe(
  Layer.provide(AgentRunToolHandlersLive)
);
