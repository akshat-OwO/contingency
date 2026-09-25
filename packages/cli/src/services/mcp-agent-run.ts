import { randomUUID } from "node:crypto";

import {
  UserAgentProfileId,
  AgentRunComplete,
  AgentRunId,
  AgentRunOpen,
  AgentRunStepAssess,
  AgentRunSummary,
  AgentRunViewer,
  AgentSessionSnapshot,
  FlowSkillRunStart,
} from "@contingency/protocol";
import type { AgentRunState, AgentRunStep } from "@contingency/protocol";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import { AgentRunStore } from "./agent-run-store.ts";
import type { AgentRunStoreError } from "./agent-run-store.ts";
import { AgentSession } from "./agent-session.ts";
import type { AgentSessionError } from "./agent-session.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import type { FlowSkillCatalogError } from "./flow-skill-catalog.ts";
import type {
  FlowSkillEmulation,
  FlowSkillInput,
} from "./flow-skill-package.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";
import { webHost } from "./teaching-demonstration.ts";

/** The failure an MCP client reads for Interactive Run tools. */
// `Schema.Error` is a class factory, not a thrown error: the rule's autofix
// would turn this extends clause into `new Schema.Error(...)`.
// oxlint-disable-next-line unicorn/throw-new-error
class AgentRunFailure extends Schema.Error<AgentRunFailure>("AgentRunFailure")({
  code: Schema.String,
  message: Schema.String,
}) {}

const failure = (
  cause: AgentSessionError | FlowSkillCatalogError | AgentRunStoreError
) =>
  new AgentRunFailure({
    code: cause.code,
    message: `${cause.message} (${cause.code})`,
  });

/**
 * A declared input whose name is shouty snake case is a runtime Variable: the
 * user supplies it through a `supply_variable` decision and the literal never
 * enters a tool call. Every other input is ordinary text the agent passes in.
 */
const SECRET_INPUT = /^[A-Z][A-Z0-9_]*$/u;

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
    "Start an Interactive Run of a verified Flow Skill in the selected Catalog Root. It reads the saved SKILL.md, turns its numbered procedure into ordered Agent Steps, opens a fresh browser context at `url`, and activates the first Step. Supply every declared input again; an input declared in SHOUTY_SNAKE_CASE is a runtime Variable that Contingency asks the user for, so pass it here and it is refused. The Execution Boundary is the set of hosts the journey was demonstrated on, recorded in the skill's frontmatter: a `url` outside them is refused outright rather than paused, and any other top-level document the Run reaches pauses for the user. A skill saved before Contingency recorded those hosts falls back to the host of `url`. The browser reopens under the Emulation the skill was demonstrated under, so do not expect a default desktop window. You own your own plan and your own reversible retries inside the current Agent Step; Contingency owns the Step order, the ceilings, and the evidence.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    clientName: FlowSkillRunStart.fields.clientName,
    clientVersion: FlowSkillRunStart.fields.clientVersion,
    flowSkillName: FlowSkillRunStart.fields.flowSkillName,
    inputs: FlowSkillRunStart.fields.inputs,
    operationId: FlowSkillRunStart.fields.operationId,
    reportedModel: FlowSkillRunStart.fields.reportedModel,
    reportedProvider: FlowSkillRunStart.fields.reportedProvider,
    runCeilingMs: FlowSkillRunStart.fields.runCeilingMs,
    stepCeilingMs: FlowSkillRunStart.fields.stepCeilingMs,
    url: FlowSkillRunStart.fields.url,
  }),
  success: AgentSessionSnapshot,
});

const AgentRunStepAssessTool = Tool.make("agent_run_step_assess", {
  dependencies: [AgentSession],
  description:
    'Report your evidence-backed judgment of the active Agent Step in an Interactive Run or Dry Run: working, not-working, inconclusive, or blocked. The Step\'s own "Done when:" line is what you are judging against. Every reference in `evidence` must name a Browser Snapshot or an attempt this Agent Step actually produced. Only `working` advances to the next Agent Step; any other outcome ends the ordered Steps and leaves the rest unexecuted. Assessing the last Agent Step or ending early closes the browser and writes a Run Summary. A Dry Run passes only when every Step is working, coverage is complete, and no Takeover occurred. Its Summary stays with the Teaching Recording and cannot be opened with open_run.',
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
  dependencies: [AgentSession],
  description:
    "End an Interactive Run or Dry Run early, before its ordered Agent Steps are exhausted, and optionally record your closing account. An early Dry Run ending fails. A session that ended on its own has already finalized the Trace and video, closed the browser, and written its Run Summary; this answers with that same Summary. Nothing leaves the machine.",
  failure: AgentRunFailure,
  parameters: Schema.Struct({
    agentAccount: AgentRunComplete.fields.agentAccount,
    operationId: AgentRunComplete.fields.operationId,
    sessionId: AgentRunComplete.fields.sessionId,
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
 * direct Workspace action can
 * ([ADR 0029](../../../../docs/adr/0029-contingency-owns-the-sole-runner.md)).
 */
export const AgentRunTools = withStrictParameters(
  Toolkit.make(
    FlowSkillRunStartTool,
    AgentRunStepAssessTool,
    AgentRunCompleteTool,
    AgentRunOpenTool
  )
);

/**
 * Sorts a Flow Skill's declared inputs against what this Run supplied. A
 * SHOUTY_SNAKE_CASE name is a runtime Variable Contingency asks the user for,
 * so supplying one here is refused; an ordinary name left out is missing.
 */
const sortDeclaredInputs = (
  declared: readonly FlowSkillInput[],
  supplied: ReadonlyMap<string, string>
) => {
  const missing: string[] = [];
  const offered: string[] = [];
  const secretInputs: string[] = [];
  for (const { name } of declared) {
    if (SECRET_INPUT.test(name)) {
      secretInputs.push(name);
      if (supplied.has(name)) {
        offered.push(name);
      }
      continue;
    }
    if (!supplied.has(name)) {
      missing.push(name);
    }
  }
  return { missing, offered, secretInputs } satisfies Record<
    string,
    readonly string[]
  >;
};

export const AgentRunToolHandlersLive = AgentRunTools.toLayer({
  agent_flow_skill_run_start: (params) =>
    Effect.gen(function* startInteractiveRun() {
      const catalog = yield* FlowSkillCatalog;
      const store = yield* AgentRunStore;
      const session = yield* AgentSession;
      const skill = yield* catalog
        .read(params.flowSkillName)
        .pipe(Effect.mapError(failure));
      if (skill.steps.length === 0) {
        return yield* Effect.fail(
          new AgentRunFailure({
            code: "flow_skill_invalid",
            message: `Flow Skill ${params.flowSkillName} carries no numbered procedure, so there is nothing to run. (flow_skill_invalid)`,
          })
        );
      }
      const host = webHost(params.url);
      if (host === undefined) {
        return yield* Effect.fail(
          new AgentRunFailure({
            code: "flow_skill_invalid",
            message: `A Run must open an http or https page, not "${params.url}". (flow_skill_invalid)`,
          })
        );
      }
      // The demonstrated hosts are the ceiling when the package carries them.
      // A Run that opens somewhere the journey was never taught is refused
      // outright rather than silently widening the boundary (ADR 0027); a
      // package saved before stamping falls back to the opened host.
      if (skill.hosts.length > 0 && !skill.hosts.includes(host)) {
        return yield* Effect.fail(
          new AgentRunFailure({
            code: "flow_skill_invalid",
            message: `Flow Skill ${params.flowSkillName} was demonstrated on ${skill.hosts.join(", ")}, so it cannot start on ${host}. (flow_skill_invalid)`,
          })
        );
      }
      const hosts = skill.hosts.length > 0 ? skill.hosts : [host];
      const supplied = new Map(
        params.inputs.map((input) => [input.name, input.value] as const)
      );
      const { missing, offered, secretInputs } = sortDeclaredInputs(
        skill.inputs,
        supplied
      );
      if (offered.length > 0) {
        return yield* Effect.fail(
          new AgentRunFailure({
            code: "flow_skill_invalid",
            message: `${offered.join(", ")} is declared in SHOUTY_SNAKE_CASE, so it is a runtime Variable. Contingency asks the user for its value and enters it with agent_variable_enter; do not pass it here. (flow_skill_invalid)`,
          })
        );
      }
      if (missing.length > 0) {
        return yield* Effect.fail(
          new AgentRunFailure({
            code: "flow_skill_invalid",
            message: `Flow Skill ${params.flowSkillName} declares ${missing.join(", ")}, which this Run did not supply. Ask the user for each declared input before starting. (flow_skill_invalid)`,
          })
        );
      }
      const defaults = yield* store.ceilings().pipe(Effect.mapError(failure));
      const runId = AgentRunId.make(`agentrun-${randomUUID()}`);
      const directory = yield* store
        .prepare(runId)
        .pipe(Effect.mapError(failure));
      const startedAt = new Date().toISOString();
      const steps: readonly AgentRunStep[] = skill.steps.map((step) => ({
        assessment: null,
        attempts: 0,
        // A Flow Skill step declares its own observable outcome rather than a
        // separate confirmation flag, so the conservative Execution Boundary
        // guard for a mutating action stays in force for every Step.
        confirmation: false,
        description: step.description,
        doneWhen: step.doneWhen,
        endedAt: null,
        execution: "pending" as const,
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
        flowSkillName: skill.name,
        inputs: [...supplied].map(([name, value]) => ({ name, value })),
        outcome: null,
        // A placeholder, already in the past. The session re-derives both
        // deadlines from the moment the browser is actually ready, so browser
        // acquisition never eats the agent's budget — and a Run that somehow
        // skipped that step times out immediately rather than running unbounded.
        runDeadline: startedAt,
        runId,
        startedAt,
        stepDeadline: null,
        steps,
        title: skill.title,
        // Each secret input becomes one `supply_variable` decision the user
        // answers by name in the agent conversation (ADR 0037).
        variables: secretInputs.map((name) => ({
          name,
          runtime: true,
          secret: true,
          supplied: false,
        })),
      };
      return yield* session
        .start({
          activity: "run",
          artifactDirectory: directory,
          clientName: params.clientName,
          clientVersion: params.clientVersion,
          domainScope: { hosts },
          // A phone-taught journey runs as a phone: the Run reproduces the
          // Emulation the Flow Skill was demonstrated under (ADR 0013).
          emulation: demonstratedEmulation(skill.emulation),
          operationId: params.operationId,
          run,
          url: params.url,
          viewport: skill.emulation?.viewport ?? {
            deviceScaleFactor: 1,
            height: 800,
            width: 1280,
          },
        })
        .pipe(Effect.mapError(failure));
    }),
  agent_run_complete: (params) =>
    Effect.gen(function* completeInteractiveRun() {
      const session = yield* AgentSession;
      // The Run persisted its own Summary when it ended. Completing an already
      // ended Run answers with that same Summary rather than writing a second.
      return yield* session
        .completeRun(params.sessionId, params.agentAccount, params.operationId)
        .pipe(Effect.mapError(failure));
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
