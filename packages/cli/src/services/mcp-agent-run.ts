import { randomUUID } from "node:crypto";

import {
  AgentFlowRunStart,
  AgentRunComplete,
  AgentRunId,
  AgentRunOpen,
  AgentRunStepAssess,
  AgentRunSummary,
  AgentRunViewer,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import type { AgentRunState, AgentRunStep } from "@contingency/protocol";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import { AgentFlowCatalog } from "./agent-flow-catalog.ts";
import type { AgentFlowCatalogError } from "./agent-flow-catalog.ts";
import { AgentRunStore } from "./agent-run-store.ts";
import type { AgentRunStoreError } from "./agent-run-store.ts";
import { AgentSession } from "./agent-session.ts";
import type { AgentSessionError } from "./agent-session.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";

/** The failure an MCP client reads for Interactive Run tools. */
// `Schema.Error` is a class factory, not a thrown error: the rule's autofix
// would turn this extends clause into `new Schema.Error(...)`.
// oxlint-disable-next-line unicorn/throw-new-error
class AgentRunFailure extends Schema.Error<AgentRunFailure>("AgentRunFailure")({
  code: Schema.String,
  message: Schema.String,
}) {}

const failure = (
  cause: AgentSessionError | AgentFlowCatalogError | AgentRunStoreError
) =>
  new AgentRunFailure({
    code: cause.code,
    message: `${cause.message} (${cause.code})`,
  });

const AgentFlowRunStartTool = Tool.make("agent_flow_run_start", {
  dependencies: [AgentSession, AgentFlowCatalog, AgentRunStore],
  description:
    "Start an Interactive Run of an Approved Agent Flow found in the selected catalog. It opens a fresh browser context under the Agent Flow's Emulation, returns the Agent View link, and activates the first ordered Agent Step. Only approved revisions run; a draft must be verified and approved first. You own your own plan and your own reversible retries inside the current Agent Step; Contingency owns the Step order, the ceilings, and the evidence.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    agentFlowId: AgentFlowRunStart.fields.agentFlowId,
    clientName: AgentFlowRunStart.fields.clientName,
    clientVersion: AgentFlowRunStart.fields.clientVersion,
    operationId: AgentFlowRunStart.fields.operationId,
    reportedModel: AgentFlowRunStart.fields.reportedModel,
    reportedProvider: AgentFlowRunStart.fields.reportedProvider,
    revisionId: AgentFlowRunStart.fields.revisionId,
    runCeilingMs: AgentFlowRunStart.fields.runCeilingMs,
    stepCeilingMs: AgentFlowRunStart.fields.stepCeilingMs,
  }),
  success: AgentSessionSnapshot,
});

const AgentRunStepAssessTool = Tool.make("agent_run_step_assess", {
  dependencies: [AgentSession],
  description:
    "Report your evidence-backed judgment of the active Agent Step: working, not-working, inconclusive, or blocked. Every reference in `evidence` must name a Browser Snapshot or an attempt this Agent Step actually produced. Only `working` advances to the next Agent Step; any other outcome ends the ordered Steps and leaves the rest unexecuted, which is reported as incomplete coverage rather than as a failure of the website.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    evidence: AgentRunStepAssess.fields.evidence,
    explanation: AgentRunStepAssess.fields.explanation,
    operationId: AgentRunStepAssess.fields.operationId,
    outcome: AgentRunStepAssess.fields.outcome,
    sessionId: AgentRunStepAssess.fields.sessionId,
  }),
  success: AgentSessionSnapshot,
});

const AgentRunCompleteTool = Tool.make("agent_run_complete", {
  dependencies: [AgentSession, AgentRunStore],
  description:
    "End the Interactive Run. Contingency finalizes the Trace and video, closes the live browser, writes the persistent Run Summary, and switches Agent View to summary mode. The Summary reports assessment counts separately from complete or incomplete coverage. Nothing leaves the machine.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    operationId: AgentRunComplete.fields.operationId,
    sessionId: AgentRunComplete.fields.sessionId,
    summary: AgentRunComplete.fields.summary,
  }),
  success: AgentRunSummary,
});

const AgentRunOpenTool = Tool.make("open_run", {
  dependencies: [AgentSession, AgentRunStore],
  description:
    "Open a new read-only local viewer for a persisted Run, including one recorded by an MCP process that has since exited. It reads the stored Run Summary and evidence and restores no browser state.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({ runId: AgentRunOpen.fields.runId }),
  success: AgentRunViewer,
});

/**
 * The Interactive Run surface. Extending a ceiling is absent on purpose: the
 * agent whose work a ceiling bounds may not raise its own budget, and only a
 * direct Agent View action can
 * ([ADR 0029](../../../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
 */
export const AgentRunTools = withStrictParameters(
  Toolkit.make(
    AgentFlowRunStartTool,
    AgentRunStepAssessTool,
    AgentRunCompleteTool,
    AgentRunOpenTool
  )
);

export const AgentRunToolHandlersLive = AgentRunTools.toLayer({
  agent_flow_run_start: (params) =>
    Effect.gen(function* startInteractiveRun() {
      const catalog = yield* AgentFlowCatalog;
      const store = yield* AgentRunStore;
      const session = yield* AgentSession;
      const head = yield* catalog
        .get(params.agentFlowId)
        .pipe(Effect.mapError(failure));
      // A Run defaults to the Approved Agent Flow, never to whatever draft
      // happens to be in flight: reading the draft head here would let a
      // proposal nobody approved run under the identity of one that was
      // (ADR 0028: Approved Agent Flows are immutable revisions).
      const revisionId =
        params.revisionId ?? head.heads.approvedRevisionId ?? undefined;
      if (revisionId === undefined) {
        return yield* Effect.fail(
          new AgentRunFailure({
            code: "agent_flow_conflict",
            message: `Agent Flow ${params.agentFlowId} has no Approved Agent Flow to run. Ask the user to verify and approve a draft in Agent View. (agent_flow_conflict)`,
          })
        );
      }
      const found =
        revisionId === head.manifest.revisionId
          ? head
          : yield* catalog
              .get(params.agentFlowId, revisionId)
              .pipe(Effect.mapError(failure));
      // A Run executes company knowledge the user approved. A draft revision
      // is a proposal, and running one would let the agent execute a procedure
      // no one ever authorized
      // (ADR 0028: Approved Agent Flows are immutable revisions).
      if (found.manifest.status !== "approved") {
        return yield* Effect.fail(
          new AgentRunFailure({
            code: "agent_flow_conflict",
            message: `Revision ${found.manifest.revisionId} is a draft. Only an Approved Agent Flow can be run; ask the user to verify and approve it in Agent View. (agent_flow_conflict)`,
          })
        );
      }
      if (found.heads.archived) {
        return yield* Effect.fail(
          new AgentRunFailure({
            code: "agent_flow_conflict",
            message: `Agent Flow ${params.agentFlowId} is archived. Ask the user whether to restore it before running it. (agent_flow_conflict)`,
          })
        );
      }
      const defaults = yield* store.ceilings().pipe(Effect.mapError(failure));
      const runId = AgentRunId.make(`agentrun-${randomUUID()}`);
      const directory = yield* store
        .prepare(runId)
        .pipe(Effect.mapError(failure));
      const startedAt = new Date().toISOString();
      const steps: readonly AgentRunStep[] = found.manifest.steps.map(
        (step) => ({
          assessment: null,
          attempts: 0,
          confirmation: step.confirmation,
          description: step.description,
          endedAt: null,
          execution: "pending" as const,
          index: step.index,
          name: step.name,
          startedAt: null,
        })
      );
      const run: AgentRunState = {
        activeStepIndex: null,
        agentFlowId: found.manifest.agentFlowId,
        assessmentCounts: {
          blocked: 0,
          inconclusive: 0,
          notWorking: 0,
          working: 0,
        },
        attribution: {
          clientName: params.clientName?.trim() || "unknown",
          clientVersion: params.clientVersion?.trim() || "unknown",
          reportedMetadataVerified: false,
          reportedModel: params.reportedModel ?? null,
          reportedProvider: params.reportedProvider ?? null,
        },
        ceilings: {
          extensions: 0,
          runMs: params.runCeilingMs ?? defaults.runMs,
          stepMs: params.stepCeilingMs ?? defaults.stepMs,
        },
        coverage: {
          complete: false,
          executed: 0,
          total: steps.length,
          unexecuted: steps.length,
        },
        endedAt: null,
        outcome: null,
        revisionId: found.manifest.revisionId,
        // A placeholder, already in the past. The session re-derives both
        // deadlines from the moment the browser is actually ready, so browser
        // acquisition never eats the agent's budget — and a Run that somehow
        // skipped that step times out immediately rather than running unbounded.
        runDeadline: startedAt,
        runId,
        startedAt,
        stepDeadline: null,
        steps,
        title: found.manifest.title,
        variables: found.manifest.variables.map((variable) => ({
          name: variable.name,
          runtime: variable.runtime,
          secret: variable.secret,
          supplied: false,
        })),
      };
      return yield* session
        .start({
          activity: "run",
          artifactDirectory: directory,
          clientName: params.clientName,
          clientVersion: params.clientVersion,
          domainScope: found.manifest.domainScope,
          emulation: found.manifest.emulation,
          operationId: params.operationId,
          run,
          viewport: found.manifest.emulation.viewport,
        })
        .pipe(Effect.mapError(failure));
    }),
  agent_run_complete: (params) =>
    Effect.gen(function* completeInteractiveRun() {
      const session = yield* AgentSession;
      const store = yield* AgentRunStore;
      const summary = yield* session
        .completeRun(params.sessionId, params.summary, params.operationId)
        .pipe(Effect.mapError(failure));
      return yield* store.write(summary).pipe(Effect.mapError(failure));
    }),
  agent_run_step_assess: (params) =>
    Effect.gen(function* assessAgentStep() {
      const session = yield* AgentSession;
      return yield* session
        .assessStep(
          params.sessionId,
          {
            evidence: params.evidence,
            explanation: params.explanation,
            outcome: params.outcome,
          },
          params.operationId
        )
        .pipe(Effect.mapError(failure));
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
      return { summary, viewUrl };
    }),
});

/** MCP's typed Interactive Run surface. */
export const McpAgentRunLayer = McpServer.toolkit(AgentRunTools).pipe(
  Layer.provide(AgentRunToolHandlersLive)
);
