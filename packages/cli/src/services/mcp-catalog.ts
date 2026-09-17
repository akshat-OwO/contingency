import {
  AgentCatalogInfo,
  AgentCatalogSelect,
  AgentPendingDecisionResolve,
  AgentSessionSnapshot,
  FlowSkillList,
  TeachingInstructionRecord,
} from "@contingency/protocol";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import { AgentSession } from "./agent-session.ts";
import type { AgentSessionError } from "./agent-session.ts";
import { FlowSkillCatalog } from "./flow-skill-catalog.ts";
import type { FlowSkillCatalogError } from "./flow-skill-catalog.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";

/**
 * The Catalog Root, the Flow Skills inside it, and the two decisions that
 * protect execution.
 *
 * Nothing here authors a reusable artifact. A Flow Skill is written by a
 * learning agent from a Teaching Recording and kept only when the user
 * verifies it
 * ([ADR 0039](../../../../docs/adr/0039-flow-skills-are-learned-from-temporary-teaching-recordings.md)),
 * so this surface reads the catalog and relays consent.
 */

/** The failure an MCP client reads for catalog and decision tools. */
// `Schema.Error` is a class factory, not a thrown error: the rule's autofix
// would turn this extends clause into `new Schema.Error(...)`.
// oxlint-disable-next-line unicorn/throw-new-error
class AgentCatalogFailure extends Schema.Error<AgentCatalogFailure>(
  "AgentCatalogFailure"
)({
  code: Schema.String,
  message: Schema.String,
}) {}

const failure = (cause: AgentSessionError | FlowSkillCatalogError) =>
  new AgentCatalogFailure({
    code: cause.code,
    message: `${cause.message} (${cause.code})`,
  });

// A no-argument tool takes a `Record` rather than an empty `Struct`: the
// latter encodes to `anyOf: [object, array]`, which MCP clients reject.
const NoParameters = Schema.Record(Schema.String, Schema.Unknown);

const AgentCatalogGetTool = Tool.make("agent_catalog_get", {
  dependencies: [FlowSkillCatalog],
  description:
    "Read the selected Catalog Root and how many Flow Skills it holds. It defaults to the workspace's .contingency directory; Contingency never scans a user-global catalog.",
  failure: AgentCatalogFailure,
  parameters: NoParameters,
  success: AgentCatalogInfo,
});

const AgentCatalogSelectTool = Tool.make("agent_catalog_select", {
  dependencies: [FlowSkillCatalog],
  description:
    "Select the Catalog Root that bounds Flow Skill discovery and Teaching Recording storage for this MCP process. `root` must be an absolute directory path.",
  failure: AgentCatalogFailure,
  parameters: Schema.Struct({
    operationId: AgentCatalogSelect.fields.operationId,
    root: AgentCatalogSelect.fields.root,
  }),
  success: AgentCatalogInfo,
});

const FlowSkillsListTool = Tool.make("agent_flow_skills_list", {
  dependencies: [FlowSkillCatalog],
  description:
    "List the Flow Skills saved in the selected Catalog Root before teaching a journey again. Each entry names the directory, the description from SKILL.md, the declared inputs, and how many numbered steps the procedure carries. Read one with your own file tools, or run it with agent_flow_skill_run_start.",
  failure: AgentCatalogFailure,
  parameters: NoParameters,
  success: FlowSkillList,
});

const TeachingInstructionRecordTool = Tool.make(
  "agent_teaching_instruction_record",
  {
    dependencies: [AgentSession],
    description:
      "Record what the user told you to do next in a Teaching session, in their words. The instruction joins the recording's event stream in order, so a learning agent reads it beside the actions it explains. Requires an operation id.",
    failure: AgentCatalogFailure,
    parameters: Schema.Struct({
      operationId: TeachingInstructionRecord.fields.operationId,
      sessionId: TeachingInstructionRecord.fields.sessionId,
      text: TeachingInstructionRecord.fields.text,
    }),
    success: AgentSessionSnapshot,
  }
);

const AgentPendingDecisionResolveTool = Tool.make(
  "agent_pending_decision_resolve",
  {
    dependencies: [AgentSession],
    description:
      "Resolve one server-issued pending decision after the user explicitly chooses in this conversation. Use allow for a paused Execution Boundary, supply with the user's literal in value for supply_variable, or refuse for either. Ask the user for a runtime Variable in your own conversation and pass what they typed verbatim; Contingency keeps the value on this machine and never audits it. Do not resolve an ambiguous reply. userMessage is optional audit context, not proof. A stale id returns a conflict; reread pendingDecisions before asking again.",
    failure: AgentCatalogFailure,
    parameters: Schema.Struct({
      decision: AgentPendingDecisionResolve.fields.decision,
      operationId: AgentPendingDecisionResolve.fields.operationId,
      pendingDecisionId: AgentPendingDecisionResolve.fields.pendingDecisionId,
      userMessage: AgentPendingDecisionResolve.fields.userMessage,
      value: AgentPendingDecisionResolve.fields.value,
    }),
    success: AgentSessionSnapshot,
  }
);

export const AgentCatalogTools = withStrictParameters(
  Toolkit.make(
    AgentCatalogGetTool,
    AgentCatalogSelectTool,
    FlowSkillsListTool,
    TeachingInstructionRecordTool,
    AgentPendingDecisionResolveTool
  )
);

export const AgentCatalogToolHandlersLive = AgentCatalogTools.toLayer({
  agent_catalog_get: () =>
    Effect.gen(function* readCatalog() {
      const catalog = yield* FlowSkillCatalog;
      return yield* catalog.info().pipe(Effect.mapError(failure));
    }),
  agent_catalog_select: (params) =>
    Effect.gen(function* selectCatalog() {
      const catalog = yield* FlowSkillCatalog;
      return yield* catalog
        .select(params.root, params.operationId)
        .pipe(Effect.mapError(failure));
    }),
  agent_flow_skills_list: () =>
    Effect.gen(function* listFlowSkills() {
      const catalog = yield* FlowSkillCatalog;
      return yield* catalog.list().pipe(Effect.mapError(failure));
    }),
  agent_pending_decision_resolve: (params) =>
    Effect.gen(function* resolvePendingDecision() {
      const session = yield* AgentSession;
      return yield* session
        .resolvePendingDecision(params)
        .pipe(Effect.mapError(failure));
    }),
  agent_teaching_instruction_record: (params) =>
    Effect.gen(function* recordInstruction() {
      const session = yield* AgentSession;
      return yield* session
        .recordInstruction(params.sessionId, params.text, params.operationId)
        .pipe(Effect.mapError(failure));
    }),
});

/** MCP's typed Catalog Root and relayed-decision surface. */
export const McpAgentCatalogLayer = McpServer.toolkit(AgentCatalogTools).pipe(
  Layer.provide(AgentCatalogToolHandlersLive)
);
