import { randomUUID } from "node:crypto";

import {
  AgentRunComplete,
  AgentRunId,
  AgentRunOpen,
  AgentRunSummary,
  FlowRunStart,
  AgentTaskRunStart,
  AgentRunTaskInput,
  AgentTaskAssessment,
  FlowName,
  OperationId,
  AgentSessionId,
  optionalNullable,
} from "@contingency/protocol";
import type {
  AgentRunFlowReference,
  AgentSessionSnapshot,
  TaskAgentRunState,
} from "@contingency/protocol";
import { Effect, Option, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type { Mutable } from "effect/Types";

import { AgentRunStore } from "./agent-run-store.ts";
import { AgentSession } from "./agent-session.ts";
import { requestedBrowserChecks } from "./browser-check-requirements.ts";
import { markDemoWork } from "./demo-site.ts";
import { webHost } from "./domain-scope.ts";
import { FlowCatalog } from "./flow-catalog.ts";
import type { FlowPackage } from "./flow-catalog.ts";
import { flowDocuments } from "./flow-documents.ts";
import type { FlowDocumentDelivery } from "./flow-documents.ts";
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
import { readExampleFlows } from "./onboarding-examples.ts";
import {
  readRequestedFlows,
  taskVariables,
  validateTaskInputs,
} from "./requested-flows.ts";
import {
  startingRunEmulation,
  flowRunEmulation,
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

const FlowRunStartTool = Tool.make("agent_flow_run_start", {
  dependencies: [AgentSession, FlowCatalog, AgentRunStore],
  description:
    "Start one user-requested verified Flow. Prefer agent_run_start for explicit tasks or multiple flows. Private inputs use Variables.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    clientName: FlowRunStart.fields.clientName,
    clientVersion: FlowRunStart.fields.clientVersion,
    flowName: FlowRunStart.fields.flowName,
    inputs: FlowRunStart.fields.inputs,
    operationId: FlowRunStart.fields.operationId,
    reportedModel: FlowRunStart.fields.reportedModel,
    reportedProvider: FlowRunStart.fields.reportedProvider,
    url: FlowRunStart.fields.url,
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
  dependencies: [AgentSession, FlowCatalog, AgentRunStore],
  description:
    "Start a task in one browser context with user-requested verified flows and ordinary inputs. Follow nextAction. The agent owns its route. Use agent_run_update for changed instructions, flows, or inputs; request Variables only when needed. Assessments and findings preserve the browser; agent_run_complete seals evidence. Fulfill applicable scanRequirements with agent_run_scan. Takeover and Execution Boundaries remain exclusive.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    ...AgentTaskRunStart.fields,
    view: sessionViewParameter,
  }),
  success: SessionStartResult,
});
const AgentTaskRunUpdateTool = Tool.make("agent_run_update", {
  dependencies: [AgentSession, FlowCatalog],
  description:
    "Update the user instruction, requested verified flows, or ordinary inputs in the same Run. Browser state and starting Emulation persist. Inputs are flow-scoped; on-demand inputs use agent_variable_request.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    inputs: Schema.Array(AgentRunTaskInput),
    instruction: optionalNullable(Schema.String.check(Schema.isMinLength(1))),
    operationId: OperationId,
    referencedFlows: Schema.Array(FlowName),
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
    'Record an evidence-backed model assessment of the requested task or complete Dry Run flow outcome. Cite Snapshot or attempt ids produced by this Run, as a non-empty array such as [{"kind":"snapshot","id":"snapshot-2"}] or [{"kind":"attempt","id":"action-123"}]. For a Dry Run, explicitly set outcomeComplete to whether the complete flow outcome was attempted; a partial attempt cannot pass. Every outcome leaves the browser open for exploration or recovery. When this is your final assessment, call agent_run_complete next. A passing Dry Run still needs the user\'s Workspace verification before Cleanup.',
  failure: AgentRunFailure,
  parameters: taskReportParameters,
  success: SessionResult,
});
const AgentTaskFindingTool = Tool.make("agent_run_finding", {
  dependencies: [AgentSession],
  description:
    "Append an evidence-backed finding without ending the Run or replacing its task assessment. Cite a Snapshot or attempt produced by this Run. Runs cannot edit Flow documents or contracts. To propose a change, put the Flow name, relative document or contract path, rationale, and proposed text or diff in explanation. The proposal is retained in the Run Summary and shown to the user in Workspace findings; it is never applied to the Flow.",
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
    flowName: FlowName,
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
    flowName: FlowName,
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
    FlowRunStartTool,
    AgentRunCompleteTool,
    AgentRunOpenTool,
    AgentTaskRunStartTool,
    AgentTaskRunUpdateTool,
    AgentTaskAssessTool,
    AgentTaskFindingTool
  )
);

/**
 * How a Run resolves the flows it starts with. A catalog Run reads only
 * user-verified packages from the selected Catalog Root. An Example Run is
 * handed bundled Example Flows explicitly and records their origin, so
 * neither path can pass for the other (ADR 0050).
 */
export type TaskRunFlows =
  | { readonly origin: "catalog" }
  | {
      readonly origin: "example";
      readonly flows: readonly FlowPackage[];
    };

/** A flow reference that records a bundled Example's origin. */
const flowReference = (
  flowName: FlowName,
  referencedAt: string,
  origin: TaskRunFlows["origin"]
): AgentRunFlowReference => {
  const reference: Mutable<AgentRunFlowReference> = {
    flowName,
    referencedAt,
  };
  if (origin === "example") {
    reference.origin = "example";
  }
  return reference;
};

export const startTaskRun = (
  params: AgentTaskRunStart,
  resolution: TaskRunFlows
) =>
  Effect.gen(function* openTaskRun() {
    const session = yield* AgentSession;
    const store = yield* AgentRunStore;
    const catalog = yield* FlowCatalog;
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
          const flows =
            resolution.origin === "example"
              ? resolution.flows
              : yield* readRequestedFlows(params.referencedFlows).pipe(
                  Effect.provideService(FlowCatalog, catalog)
                );
          yield* validateTaskInputs(flows, params.inputs);
          const host = webHost(params.url);
          if (host === undefined) {
            return yield* Effect.fail(
              new AgentRunFailure({
                code: "flow_invalid",
                message: "A task Run starts on an http or https page.",
              })
            );
          }
          const hosts = [...new Set(flows.flatMap((flow) => flow.hosts))];
          if (hosts.length === 0) {
            hosts.push(host);
          }
          if (!hosts.includes(host)) {
            return yield* Effect.fail(
              new AgentRunFailure({
                code: "flow_invalid",
                message: `The requested flows were demonstrated on ${hosts.join(", ")}, so this Run cannot start on ${host}.`,
              })
            );
          }

          const { emulation, source, runtimeRequirements } =
            yield* startingRunEmulation(flows);
          const runId = AgentRunId.make(`agentrun-${randomUUID()}`);
          const artifactDirectory = yield* store.prepare(
            runId,
            resolution.origin === "example"
              ? []
              : flows.map((flow) => flow.name)
          );
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
            browserChecks: yield* requestedBrowserChecks(flows),
            emulationSource:
              source === undefined
                ? { kind: "default" }
                : { flowName: source, kind: "flow" },
            findings: [],
            inputs: params.inputs,
            instructions: [],
            lastAgentActivityAt: startedAt,
            lifecycle: { phase: "running" },
            purpose: { kind: "interactive" },
            referencedFlows: flows.map((flow) =>
              flowReference(flow.name, startedAt, resolution.origin)
            ),
            requestedTask: params.requestedTask,
            runId,
            scanReports: [],
            scanRequirements: yield* requestedScans(flows),
            schemaVersion: 3,
            startedAt,
            startingEmulation: emulation,
            title: params.requestedTask,
            variables: flows.flatMap(taskVariables),
          });
          return {
            activity: "run" as const,
            artifactDirectory,
            clientName: params.clientName,
            clientVersion: params.clientVersion,
            domainScope: { hosts },
            emulation,
            flowDocuments: flows.map((flow) => ({
              flowName: flow.name,
              ...flowDocuments(flow.files),
            })),
            run,
            runtimeRequirements,
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

const withDocumentView =
  <A, E2, R2>(
    present: (
      effect: Effect.Effect<AgentSessionSnapshot>
    ) => Effect.Effect<A, E2, R2>
  ) =>
  <E, R>(
    effect: Effect.Effect<AgentSessionSnapshot & FlowDocumentDelivery, E, R>
  ) =>
    effect.pipe(
      Effect.flatMap((snapshot) =>
        present(Effect.succeed(snapshot)).pipe(
          Effect.map((result) => ({
            ...result,
            flowDocuments: snapshot.flowDocuments ?? [],
          }))
        )
      )
    );

const offerVerification = makeVerificationElicitation();

export const AgentRunToolHandlersLive = AgentRunTools.toLayer({
  agent_flow_run_start: ({ view, ...params }) =>
    startTaskRun(
      {
        ...params,
        inputs: params.inputs.map((input) => ({
          ...input,
          flowName: params.flowName,
        })),
        referencedFlows: [params.flowName],
        requestedTask: `Run Flow ${params.flowName}`,
      },
      { origin: "catalog" }
    ).pipe(withDocumentView(inStartView(view))),
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
          params.flowName,
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
          params.flowName,
          params.requirementId,
          params.reason,
          params.operationId
        )
        .pipe(Effect.mapError(failure), inView(params.view));
    }),
  agent_run_start: ({ view, ...params }) =>
    startTaskRun(params, { origin: "catalog" }).pipe(
      withDocumentView(inStartView(view))
    ),
  agent_run_update: ({ view, ...params }) =>
    Effect.gen(function* updateTaskRun() {
      const session = yield* AgentSession;
      const catalog = yield* FlowCatalog;
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
          ...run.referencedFlows.map((flow) => flow.flowName),
          ...params.referencedFlows,
        ]);
        if (params.inputs.some((input) => !referenced.has(input.flowName))) {
          return yield* Effect.fail(
            new AgentRunFailure({
              code: "flow_invalid",
              message: "Task inputs must belong to a user-requested Flow.",
            })
          );
        }
        // An Example Run keeps resolving its bundled flows from the bundle;
        // every other name is a user-verified catalog flow.
        const examples = new Set(
          run.referencedFlows.flatMap((flow) =>
            flow.origin === "example" ? [flow.flowName] : []
          )
        );
        const names = [
          ...params.referencedFlows,
          ...params.inputs.map((input) => input.flowName),
        ];
        const flows = [
          ...(yield* readExampleFlows(
            names.filter((name) => examples.has(name))
          ).pipe(Effect.provideService(FlowCatalog, catalog))),
          ...(yield* readRequestedFlows(
            names.filter((name) => !examples.has(name))
          ).pipe(Effect.provideService(FlowCatalog, catalog))),
        ];
        yield* validateTaskInputs(flows, params.inputs);
        const checks = yield* requestedBrowserChecks(flows);
        const scans = yield* requestedScans(flows);
        const requested = new Set(params.referencedFlows);
        const emulationConflicts = [];
        for (const flow of flows) {
          if (!requested.has(flow.name)) {
            continue;
          }
          const expected = yield* flowRunEmulation(flow);
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
              flowName: flow.name,
              recovery: `The current browser keeps its starting emulation. Start a separate Run of ${flow.name} to reproduce its saved environment, or continue this composed task only where the differing environment is acceptable.`,
            });
          }
        }
        return {
          emulationConflicts,
          flowDocuments: flows.flatMap((flow) =>
            requested.has(flow.name)
              ? [{ flowName: flow.name, ...flowDocuments(flow.files) }]
              : []
          ),
          flows: flows.flatMap((flow) =>
            requested.has(flow.name)
              ? [
                  {
                    browserChecks: checks.filter(
                      (reference) => reference.flowName === flow.name
                    ),
                    flowName: flow.name,
                    hosts: flow.hosts,
                    scans: scans.filter((scan) => scan.flowName === flow.name),
                    variables: taskVariables(flow),
                  },
                ]
              : []
          ),
          inputs: params.inputs,
          instruction: params.instruction,
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
          withDocumentView(inView(view))
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
