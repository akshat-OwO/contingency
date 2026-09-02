import {
  AgentCatalogInfo,
  AgentCatalogSelect,
  AgentFlowDiagnostic,
  AgentFlowDraftSave,
  AgentFlowGet,
  AgentFlowRevision,
  AgentFlowSearch,
  AgentFlowSearchResult,
  AgentSessionSnapshot,
  TeachingFeed,
  TeachingFeedGet,
  TeachingInstructionRecord,
} from "@contingency/protocol";
import { Effect, Layer, Result, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import { AgentFlowCatalog } from "./agent-flow-catalog.ts";
import type { AgentFlowCatalogError } from "./agent-flow-catalog.ts";
import { compileAgentFlowDraft } from "./agent-flow-compiler.ts";
import { AgentSession } from "./agent-session.ts";
import type { AgentSessionError } from "./agent-session.ts";

/**
 * The failure an MCP client reads for catalog and Teaching tools. Refused
 * compiler output carries its structured diagnostics so the agent can correct
 * the proposal rather than guess
 * ([ADR 0025](../../../../docs/adr/0025-agent-flow-is-compiled-from-a-demonstration.md)).
 */
// `Schema.Error` is a class factory, not a thrown error: the rule's autofix
// would turn this extends clause into `new Schema.Error(...)`.
// oxlint-disable-next-line unicorn/throw-new-error
class AgentFlowFailure extends Schema.Error<AgentFlowFailure>(
  "AgentFlowFailure"
)({
  code: Schema.String,
  diagnostics: Schema.Array(AgentFlowDiagnostic),
  message: Schema.String,
}) {}

const failure = (cause: AgentSessionError | AgentFlowCatalogError) =>
  new AgentFlowFailure({
    code: cause.code,
    diagnostics: [],
    message: `${cause.message} (${cause.code})`,
  });

const invalidDraft = (diagnostics: readonly AgentFlowDiagnostic[]) =>
  new AgentFlowFailure({
    code: "agent_flow_invalid",
    diagnostics,
    message: `The draft was not saved: ${diagnostics
      .map(
        (diagnostic) =>
          `${diagnostic.code} at ${diagnostic.path.join(".") || "(root)"}: ${diagnostic.message}`
      )
      .join(" ")} (agent_flow_invalid)`,
  });

// A no-argument tool takes a `Record` rather than an empty `Struct`: the
// latter encodes to `anyOf: [object, array]`, which MCP clients reject.
const NoParameters = Schema.Record(Schema.String, Schema.Unknown);

const AgentCatalogGetTool = Tool.make("agent_catalog_get", {
  dependencies: [AgentFlowCatalog],
  description:
    "Read the selected Agent Flow Catalog Root. It defaults to the workspace's .contingency directory; Contingency never scans a user-global catalog.",
  failure: AgentFlowFailure,
  parameters: NoParameters,
  success: AgentCatalogInfo,
});

const AgentCatalogSelectTool = Tool.make("agent_catalog_select", {
  dependencies: [AgentFlowCatalog],
  description:
    "Select the Catalog Root that bounds Agent Flow discovery and storage for this MCP process. `root` must be an absolute directory path.",
  failure: AgentFlowFailure,
  parameters: Schema.Struct({ root: AgentCatalogSelect.fields.root }),
  success: AgentCatalogInfo,
});

const AgentCatalogSearchTool = Tool.make("agent_catalog_search", {
  dependencies: [AgentFlowCatalog],
  description:
    "Search the selected Agent Flow Catalog before teaching: deterministic filters (status, tag, host) plus local full-text search over titles, descriptions, tags, and Agent Step descriptions. Results label drafts separately from approved revisions; a draft match should be offered for continuation, never treated as approved coverage.",
  failure: AgentFlowFailure,
  parameters: Schema.Struct({
    host: AgentFlowSearch.fields.host,
    limit: AgentFlowSearch.fields.limit,
    query: AgentFlowSearch.fields.query,
    status: AgentFlowSearch.fields.status,
    tag: AgentFlowSearch.fields.tag,
  }),
  success: AgentFlowSearchResult,
});

const AgentFlowGetTool = Tool.make("agent_flow_get", {
  dependencies: [AgentFlowCatalog],
  description:
    "Read one Agent Flow revision package: the named revision, or the current draft head.",
  failure: AgentFlowFailure,
  parameters: Schema.Struct({
    agentFlowId: AgentFlowGet.fields.agentFlowId,
    revisionId: AgentFlowGet.fields.revisionId,
  }),
  success: AgentFlowRevision,
});

const TeachingInstructionRecordTool = Tool.make(
  "agent_teaching_instruction_record",
  {
    dependencies: [AgentSession],
    description:
      "Record what the user told you to do next in a Teaching session, in their words. Instructions join the Demonstration and become part of the Evidence Slice of the Agent Step they fall in. Requires an operation id.",
    failure: AgentFlowFailure,
    parameters: Schema.Struct({
      operationId: TeachingInstructionRecord.fields.operationId,
      sessionId: TeachingInstructionRecord.fields.sessionId,
      text: TeachingInstructionRecord.fields.text,
    }),
    success: AgentSessionSnapshot,
  }
);

const TeachingFeedGetTool = Tool.make("agent_teaching_feed_get", {
  dependencies: [AgentSession],
  description:
    "Read the bounded Teaching Feed of a Teaching session: user instructions, captured actions with actor and outcome, URL transitions, and the observed hosts to propose as Domain Scope. Pass includeSnapshots to receive the Browser Snapshots the actions reference. Cookies, headers, network bodies, video, and the full Trace are never included.",
  failure: AgentFlowFailure,
  parameters: Schema.Struct({
    includeSnapshots: TeachingFeedGet.fields.includeSnapshots,
    sessionId: TeachingFeedGet.fields.sessionId,
  }),
  success: TeachingFeed,
});

const AgentFlowDraftSaveTool = Tool.make("agent_flow_draft_save", {
  dependencies: [AgentSession, AgentFlowCatalog],
  description:
    "Compile a Teaching session's Demonstration into a draft Agent Flow revision and save it to the selected catalog. Each Agent Step names an inclusive span of captured action ids; Contingency derives the Evidence Slices. Domain Scope may only cover hosts the demonstrated Steps visited. Invalid output is refused with structured diagnostics and never enters the catalog. Pass agentFlowId and basedOnRevisionId to revise an existing draft; a moved head is a conflict.",
  failure: AgentFlowFailure,
  parameters: Schema.Struct({
    agentFlowId: AgentFlowDraftSave.fields.agentFlowId,
    basedOnRevisionId: AgentFlowDraftSave.fields.basedOnRevisionId,
    draft: AgentFlowDraftSave.fields.draft,
    operationId: AgentFlowDraftSave.fields.operationId,
    sessionId: AgentFlowDraftSave.fields.sessionId,
  }),
  success: AgentFlowRevision,
});

/**
 * Catalog, Teaching Feed, and compilation tools. Approval and verification are
 * absent on purpose: Agent View alone authorizes those
 * ([ADR 0027](../../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
 */
export const AgentFlowTools = Toolkit.make(
  AgentCatalogGetTool,
  AgentCatalogSelectTool,
  AgentCatalogSearchTool,
  AgentFlowGetTool,
  TeachingInstructionRecordTool,
  TeachingFeedGetTool,
  AgentFlowDraftSaveTool
);

export const AgentFlowToolHandlersLive = AgentFlowTools.toLayer({
  agent_catalog_get: () =>
    Effect.gen(function* readCatalog() {
      const catalog = yield* AgentFlowCatalog;
      return yield* catalog.info().pipe(Effect.mapError(failure));
    }),
  agent_catalog_search: (params) =>
    Effect.gen(function* searchCatalog() {
      const catalog = yield* AgentFlowCatalog;
      return yield* catalog.search(params).pipe(Effect.mapError(failure));
    }),
  agent_catalog_select: (params) =>
    Effect.gen(function* selectCatalog() {
      const catalog = yield* AgentFlowCatalog;
      return yield* catalog.select(params.root).pipe(Effect.mapError(failure));
    }),
  agent_flow_draft_save: (params) =>
    Effect.gen(function* saveDraft() {
      const session = yield* AgentSession;
      const catalog = yield* AgentFlowCatalog;
      const source = yield* session
        .teachingSource(params.sessionId)
        .pipe(Effect.mapError(failure));
      const compiled = compileAgentFlowDraft(
        params.draft,
        source.demonstration
      );
      if (Result.isFailure(compiled)) {
        return yield* Effect.fail(invalidDraft(compiled.failure));
      }
      const saved = yield* catalog
        .saveDraft({
          agentFlowId: params.agentFlowId,
          basedOnRevisionId: params.basedOnRevisionId,
          compiler: {
            clientName: source.session.clientName,
            clientVersion: source.session.clientVersion,
          },
          emulation: source.emulation,
          operationId: params.operationId,
          proposal: params.draft,
          slices: compiled.success,
          sourceSessionId: params.sessionId,
        })
        .pipe(Effect.mapError(failure));
      yield* session
        .recordDraft(params.sessionId, {
          agentFlowId: saved.manifest.agentFlowId,
          revisionId: saved.manifest.revisionId,
          savedAt: saved.manifest.createdAt,
          title: saved.manifest.title,
        })
        .pipe(Effect.mapError(failure));
      return saved;
    }),
  agent_flow_get: (params) =>
    Effect.gen(function* readAgentFlow() {
      const catalog = yield* AgentFlowCatalog;
      return yield* catalog
        .get(params.agentFlowId, params.revisionId)
        .pipe(Effect.mapError(failure));
    }),
  agent_teaching_feed_get: (params) =>
    Effect.gen(function* readTeachingFeed() {
      const session = yield* AgentSession;
      return yield* session
        .teachingFeed(params.sessionId, params.includeSnapshots ?? false)
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

/** MCP's typed catalog and Teaching surface. */
export const McpAgentFlowLayer = McpServer.toolkit(AgentFlowTools).pipe(
  Layer.provide(AgentFlowToolHandlersLive)
);
