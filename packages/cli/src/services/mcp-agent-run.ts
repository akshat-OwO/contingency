import { randomUUID } from "node:crypto";

import {
  UserAgentProfileId,
  AgentRunComplete,
  AgentRunId,
  AgentRunOpen,
  AgentRunStepAssess,
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
import type { TaskAgentRunState } from "@contingency/protocol";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";

import { AgentRunStore } from "./agent-run-store.ts";
import { AgentSession } from "./agent-session.ts";
import { webHost } from "./domain-scope.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import type { FlowSkillEmulation } from "./flow-skill-package.ts";
import {
  SessionResult,
  UnpublishedRunSummary,
  encodeUnpublishedRunSummary,
  inView,
  sessionViewParameter,
} from "./mcp-session-output.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { readOnly } from "./mcp-tool-annotations.ts";
import {
  PRIVATE_INPUT_NAME,
  readRequestedSkills,
  taskVariables,
  validateTaskInputs,
} from "./requested-flow-skills.ts";

/** The failure an MCP client reads for Interactive Run tools. */
// `Schema.Error` is a class factory, not a thrown error: the rule's autofix
// would turn this extends clause into `new Schema.Error(...)`.
// oxlint-disable-next-line unicorn/throw-new-error
class AgentRunFailure extends Schema.Error<AgentRunFailure>("AgentRunFailure")({
  code: Schema.String,
  message: Schema.String,
}) {}

const failure = (cause: { readonly code: string; readonly message: string }) =>
  new AgentRunFailure({
    code: cause.code,
    message: `${cause.message} (${cause.code})`,
  });

/**
 * A stamped identity that no longer exists in this build falls back to the
 * default rather than refusing the Run: the journey still matters when a
 * profile name is retired, and the viewport carries the shape that does.
 */
const readUserAgentProfileId = (
  value: string | undefined
): UserAgentProfileId =>
  Schema.is(UserAgentProfileId)(value) ? value : "default";

const readColorScheme = (
  value: string | undefined
): "dark" | "light" | undefined =>
  value === "dark" || value === "light" ? value : undefined;

/**
 * The Emulation a Run reproduces, or `undefined` for a package saved before
 * Contingency stamped one. Without a viewport there is no coherent device to
 * restore, so the Run opens at Contingency's default instead of half of one.
 */
const demonstratedEmulation = (emulation: FlowSkillEmulation | undefined) =>
  emulation === undefined || emulation.viewport === undefined
    ? undefined
    : {
        colorScheme: readColorScheme(emulation.colorScheme),
        geolocation: emulation.geolocation,
        locale: emulation.locale,
        permissions: emulation.permissions,
        timezoneId: emulation.timezone,
        userAgentProfile: readUserAgentProfileId(emulation.userAgentProfile),
        viewport: emulation.viewport,
      };

const FlowSkillRunStartTool = Tool.make("agent_flow_skill_run_start", {
  dependencies: [AgentSession, FlowSkillCatalog, AgentRunStore],
  description:
    "Start a task Run using one user-requested verified Flow Skill. This compatibility adapter uses the skill name as the requested task. Prefer agent_run_start for explicit tasks or multiple skills. Inputs are supplied only when needed; private inputs use on-demand Variable decisions. Assessments leave the browser open until explicit completion.",
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
  success: SessionResult,
});

const AgentRunCompleteTool = Tool.make("agent_run_complete", {
  dependencies: [AgentSession],
  description:
    "Explicitly complete an Interactive Run or seal a Dry Run outcome report, and optionally record your closing account. Call it as soon as your final assessment is recorded: the browser stays open until you do. Completion seals local evidence and disposes resources once; assessments alone do not end the browser. A Dry Run can pass only after this call seals a working, complete outcome report without user Takeover. A partial or unassessed attempt fails. Completing an ended session returns its persisted Run Summary. Nothing leaves the machine.",
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
    "Start an Interactive Run for the user's requested task, with zero or more user-requested verified Flow Skills. Inputs are optional until needed. The agent interprets the procedures and stopping points. One browser context and its starting Emulation persist across referenced skills, changed instructions, findings, and recovery. Use agent_run_update to record later user instructions or requested skills, agent_run_variable_request when a private input is needed, agent_run_assess or agent_run_finding to report evidence, and agent_run_complete to seal evidence and close the browser. No wall-clock ceiling applies; per-action timeouts and exclusive Takeover remain.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    ...AgentTaskRunStart.fields,
    view: sessionViewParameter,
  }),
  success: SessionResult,
});
const AgentTaskRunUpdateTool = Tool.make("agent_run_update", {
  dependencies: [AgentSession, FlowSkillCatalog],
  description:
    "Record a changed user instruction, additional user-requested verified skills, or newly supplied ordinary inputs in the same Run. Reference only skills the user requested. This preserves pages, tabs, authentication, storage, and starting Emulation. Values belong to their flowSkillName and name. Secret inputs must use agent_run_variable_request and agent_variable_enter instead.",
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
  evidence: AgentRunStepAssess.fields.evidence,
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
const AgentTaskVariableRequestTool = Tool.make("agent_run_variable_request", {
  dependencies: [AgentSession],
  description:
    "Request a declared private/runtime input only when needed. The flowSkillName and name together identify the value. Present the returned Pending Decision to the user, relay supply/refusal with agent_pending_decision_resolve, then enter it with agent_variable_enter using the same flowSkillName. For a Dry Run prerequisite, the user supplies or refuses the value in Workspace. Set replace:true to invalidate a supplied value and request a fresh one. Unused declared inputs do not pause startup or browser actions.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    flowSkillName: FlowSkillName,
    name: Schema.String.check(Schema.isPattern(PRIVATE_INPUT_NAME)),
    operationId: OperationId,
    replace: optionalNullable(Schema.Boolean),
    sessionId: AgentSessionId,
    view: sessionViewParameter,
  }),
  success: SessionResult,
});

/** The Interactive Run surface. */
export const AgentRunTools = withStrictParameters(
  Toolkit.make(
    FlowSkillRunStartTool,
    AgentRunCompleteTool,
    AgentRunOpenTool,
    AgentTaskRunStartTool,
    AgentTaskRunUpdateTool,
    AgentTaskAssessTool,
    AgentTaskFindingTool,
    AgentTaskVariableRequestTool
  )
);

const startTaskRun = (params: AgentTaskRunStart) =>
  Effect.gen(function* openTaskRun() {
    const session = yield* AgentSession;
    const store = yield* AgentRunStore;
    const catalog = yield* FlowSkillCatalog;
    return yield* session
      .startPrepared(
        {
          operationId: params.operationId,
          request: JSON.stringify({ activity: "task-run", ...params }),
        },
        Effect.gen(function* prepareTaskRun() {
          const skills = yield* readRequestedSkills(
            params.referencedSkills
          ).pipe(Effect.provideService(FlowSkillCatalog, catalog));
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

          const runId = AgentRunId.make(`agentrun-${randomUUID()}`);
          const artifactDirectory = yield* store.prepare(runId);
          const startedAt = new Date().toISOString();
          const demonstrated = demonstratedEmulation(skills[0]?.emulation);
          const emulation = {
            ...demonstrated,
            permissions: demonstrated?.permissions ?? [],
            userAgentProfile:
              demonstrated?.userAgentProfile ??
              UserAgentProfileId.make("default"),
            viewport: demonstrated?.viewport ?? {
              deviceScaleFactor: 1,
              height: 800,
              width: 1280,
            },
          };
          if (emulation.colorScheme === undefined) {
            delete emulation.colorScheme;
          }
          if (emulation.geolocation === undefined) {
            delete emulation.geolocation;
          }
          if (emulation.locale === undefined) {
            delete emulation.locale;
          }
          if (emulation.timezoneId === undefined) {
            delete emulation.timezoneId;
          }
          const run: TaskAgentRunState = {
            assessment: null,
            attribution: {
              clientName: params.clientName ?? "unknown",
              clientVersion: params.clientVersion ?? "unknown",
              reportedMetadataVerified: false,
              reportedModel: params.reportedModel ?? null,
              reportedProvider: params.reportedProvider ?? null,
            },
            findings: [],
            inputs: params.inputs,
            instructions: [],
            lastAgentActivityAt: startedAt,
            lifecycle: { phase: "running" },
            purpose: { kind: "interactive" },
            referencedSkills: skills.map((skill) => ({
              flowSkillName: skill.name,
              referencedAt: startedAt,
            })),
            requestedTask: params.requestedTask,
            runId,
            schemaVersion: 3,
            startedAt,
            startingEmulation: emulation,
            title: params.requestedTask,
            variables: skills.flatMap(taskVariables),
          };
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

export const AgentRunToolHandlersLive = AgentRunTools.toLayer({
  agent_flow_skill_run_start: ({ view, ...params }) =>
    startTaskRun({
      ...params,
      inputs: params.inputs.map((input) => ({
        ...input,
        flowSkillName: params.flowSkillName,
      })),
      referencedSkills: [params.flowSkillName],
      requestedTask: `Run Flow Skill ${params.flowSkillName}`,
    }).pipe(inView(view)),
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
      return yield* session
        .completeRun(params.sessionId, params.agentAccount, params.operationId)
        .pipe(Effect.mapError(failure));
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
  agent_run_start: ({ view, ...params }) =>
    startTaskRun(params).pipe(inView(view)),
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
        const skills = yield* readRequestedSkills([
          ...params.referencedSkills,
          ...params.inputs.map((input) => input.flowSkillName),
        ]).pipe(Effect.provideService(FlowSkillCatalog, catalog));
        yield* validateTaskInputs(skills, params.inputs);
        const requested = new Set(params.referencedSkills);
        return {
          inputs: params.inputs,
          instruction: params.instruction,
          skills: skills.flatMap((skill) =>
            requested.has(skill.name)
              ? [
                  {
                    flowSkillName: skill.name,
                    hosts: skill.hosts,
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
  agent_run_variable_request: (params) =>
    Effect.gen(function* requestTaskInput() {
      const session = yield* AgentSession;
      return yield* session
        .requestTaskVariable(
          params.sessionId,
          params.flowSkillName,
          params.name,
          params.operationId,
          params.replace ?? false
        )
        .pipe(Effect.mapError(failure), inView(params.view));
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
