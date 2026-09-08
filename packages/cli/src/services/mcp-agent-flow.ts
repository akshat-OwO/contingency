import {
  AgentCatalogInfo,
  AgentCatalogSelect,
  AgentFlowArchive,
  AgentFlowDiagnostic,
  AgentFlowDraftSave,
  AgentFlowGet,
  AgentFlowRevision,
  AgentFlowSearch,
  AgentFlowSearchResult,
  AgentFlowVerificationComplete,
  AgentFlowVerificationStart,
  AgentSessionSnapshot,
  TeachingFeed,
  TeachingFeedGet,
  TeachingScreenshotContent,
  TeachingScreenshotGet,
  TeachingInstructionRecord,
} from "@contingency/protocol";
import type { AgentSessionVerification } from "@contingency/protocol";
import { Effect, Layer, Result, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";

import {
  AgentFlowCatalog,
  normalizedDraftSaveInput,
} from "./agent-flow-catalog.ts";
import type { AgentFlowCatalogError } from "./agent-flow-catalog.ts";
import { compileAgentFlowDraft } from "./agent-flow-compiler.ts";
import { AgentSession } from "./agent-session.ts";
import type { AgentSessionError } from "./agent-session.ts";
import { withStrictParameters } from "./mcp-strict-parameters.ts";

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
  parameters: Schema.Struct({
    operationId: AgentCatalogSelect.fields.operationId,
    root: AgentCatalogSelect.fields.root,
  }),
  success: AgentCatalogInfo,
});

const AgentCatalogSearchTool = Tool.make("agent_catalog_search", {
  dependencies: [AgentFlowCatalog],
  description:
    "Search the selected Agent Flow Catalog before teaching: deterministic filters (status, tag, host) plus local full-text search over titles, descriptions, tags, and Agent Step descriptions. Results label drafts separately from approved revisions; a draft match should be offered for continuation, never treated as approved coverage.",
  failure: AgentFlowFailure,
  parameters: Schema.Struct({
    archived: AgentFlowSearch.fields.archived,
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

const AgentFlowArchiveTool = Tool.make("agent_flow_archive", {
  dependencies: [AgentFlowCatalog],
  description:
    "Archive or restore an Agent Flow after reading its current draft and approved heads. Archived Agent Flows stay recoverable but disappear from default search. A changed head returns a conflict. Permanent deletion is unavailable to agents and requires direct user confirmation in Agent View.",
  failure: AgentFlowFailure,
  parameters: Schema.Struct({
    agentFlowId: AgentFlowArchive.fields.agentFlowId,
    archived: AgentFlowArchive.fields.archived,
    expectedHeads: AgentFlowArchive.fields.expectedHeads,
    operationId: AgentFlowArchive.fields.operationId,
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
    "Read the bounded Teaching Feed of a Teaching session: user instructions, captured actions with actor and outcome, URL transitions, screenshot references, and the observed hosts to propose as Domain Scope. Pass includeSnapshots to receive the Browser Snapshots the actions reference. Screenshot bytes are never inlined; fetch one with agent_teaching_screenshot_get. Cookies, headers, network bodies, video, and the full Trace are never included.",
  failure: AgentFlowFailure,
  parameters: Schema.Struct({
    includeSnapshots: TeachingFeedGet.fields.includeSnapshots,
    sessionId: TeachingFeedGet.fields.sessionId,
  }),
  success: TeachingFeed,
});

const TeachingScreenshotGetTool = Tool.make("agent_teaching_screenshot_get", {
  dependencies: [AgentSession],
  description:
    "Fetch the bytes of one screenshot the Teaching Feed referenced, as base64 PNG. The feed carries references so it stays readable; ask for an image only when you need to look at it. An unknown reference is refused.",
  failure: AgentFlowFailure,
  parameters: Schema.Struct({
    screenshotId: TeachingScreenshotGet.fields.screenshotId,
    sessionId: TeachingScreenshotGet.fields.sessionId,
  }),
  success: TeachingScreenshotContent,
});

const AgentFlowDraftSaveTool = Tool.make("agent_flow_draft_save", {
  dependencies: [AgentSession, AgentFlowCatalog],
  description:
    "Compile a Teaching session's Demonstration into a draft Agent Flow revision and save it to the selected catalog. Each Agent Step names an inclusive span of captured action ids; Contingency derives the Evidence Slices. Domain Scope may only cover hosts the demonstrated Steps visited. Invalid output is refused with structured diagnostics and never enters the catalog. Pass agentFlowId and basedOnRevisionId to revise the current draft or Approved Agent Flow; a moved head is a conflict.",
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

const AgentFlowVerificationStartTool = Tool.make(
  "agent_flow_verification_start",
  {
    dependencies: [AgentSession, AgentFlowCatalog],
    description:
      "Start the Verification Run the user authorized in Agent View for one exact draft revision. It opens a fresh browser context under the draft's Emulation, inheriting nothing Teaching prepared, and its runtime Variables must be supplied again by the user. Fails when the user has not authorized this exact revision or has already spent the authorization; ask the user to authorize verification in Agent View rather than retrying.",
    failure: AgentFlowFailure,
    parameters: Schema.Struct({
      agentFlowId: AgentFlowVerificationStart.fields.agentFlowId,
      clientName: AgentFlowVerificationStart.fields.clientName,
      clientVersion: AgentFlowVerificationStart.fields.clientVersion,
      operationId: AgentFlowVerificationStart.fields.operationId,
      revisionId: AgentFlowVerificationStart.fields.revisionId,
    }),
    success: AgentSessionSnapshot,
  }
);

const AgentFlowVerificationCompleteTool = Tool.make(
  "agent_flow_verification_complete",
  {
    dependencies: [AgentSession, AgentFlowCatalog],
    description:
      "Report how the Verification Run ended, with an explanation grounded in what you observed. A failure leaves any existing Approved Agent Flow untouched and lets you propose a changed draft, which the user must authorize again. Only the user can approve a passed revision.",
    failure: AgentFlowFailure,
    parameters: Schema.Struct({
      operationId: AgentFlowVerificationComplete.fields.operationId,
      outcome: AgentFlowVerificationComplete.fields.outcome,
      sessionId: AgentFlowVerificationComplete.fields.sessionId,
      summary: AgentFlowVerificationComplete.fields.summary,
    }),
    success: AgentFlowRevision,
  }
);

/**
 * Catalog, Teaching Feed, compilation, and Verification Run tools. Authorizing
 * verification and approving a revision are absent on purpose: Agent View
 * alone grants those
 * ([ADR 0027](../../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
 */
export const AgentFlowTools = withStrictParameters(
  Toolkit.make(
    AgentCatalogGetTool,
    AgentCatalogSelectTool,
    AgentCatalogSearchTool,
    AgentFlowGetTool,
    AgentFlowArchiveTool,
    TeachingInstructionRecordTool,
    TeachingFeedGetTool,
    TeachingScreenshotGetTool,
    AgentFlowDraftSaveTool,
    AgentFlowVerificationStartTool,
    AgentFlowVerificationCompleteTool
  )
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
      return yield* catalog
        .select(params.root, params.operationId)
        .pipe(Effect.mapError(failure));
    }),
  agent_flow_archive: (params) =>
    Effect.gen(function* archiveAgentFlow() {
      const catalog = yield* AgentFlowCatalog;
      return yield* catalog.setArchived(params).pipe(Effect.mapError(failure));
    }),
  agent_flow_draft_save: (params) =>
    Effect.gen(function* saveDraft() {
      const catalog = yield* AgentFlowCatalog;
      const saveInput = {
        basedOnRevisionId: params.basedOnRevisionId,
        proposal: params.draft,
        sourceSessionId: params.sessionId,
      };
      const requestInput = normalizedDraftSaveInput(
        params.agentFlowId === undefined
          ? saveInput
          : { ...saveInput, agentFlowId: params.agentFlowId }
      );
      const replay = yield* catalog
        .replayDraftSave(params.operationId, requestInput)
        .pipe(Effect.mapError(failure));
      if (replay !== null) {
        return replay;
      }
      const session = yield* AgentSession;
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
          screenshots: [...source.demonstration.screenshotContents.values()],
          slices: compiled.success,
          sourceArtifacts: {
            retentionFile: source.retentionFile,
            traceFile: source.traceFile,
            videoFile: source.videoFile,
          },
          sourceSessionId: params.sessionId,
        })
        .pipe(Effect.mapError(failure));
      yield* session
        .recordDraft(params.sessionId, {
          agentFlowId: saved.manifest.agentFlowId,
          revisionId: saved.manifest.revisionId,
          savedAt: saved.manifest.createdAt,
          steps: saved.manifest.steps.map((step, index) => ({
            confirmation: step.confirmation,
            description: step.description,
            evidenceHash: step.evidence.hash,
            firstActionId: step.firstActionId,
            index,
            lastActionId: step.lastActionId,
            name: step.name,
          })),
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
  agent_flow_verification_complete: (params) =>
    Effect.gen(function* completeVerificationRun() {
      const catalog = yield* AgentFlowCatalog;
      const session = yield* AgentSession;
      const verifying = yield* session
        .verification(params.sessionId)
        .pipe(Effect.mapError(failure));
      const recorded = yield* catalog
        .completeVerification({
          agentFlowId: verifying.agentFlowId,
          operationId: params.operationId,
          outcome: params.outcome,
          revisionId: verifying.revisionId,
          summary: params.summary,
        })
        .pipe(Effect.mapError(failure));
      yield* session
        .recordVerificationOutcome(params.sessionId, params.outcome)
        .pipe(Effect.mapError(failure));
      return recorded;
    }),
  agent_flow_verification_start: (params) =>
    Effect.gen(function* startVerificationRun() {
      const catalog = yield* AgentFlowCatalog;
      const session = yield* AgentSession;
      const draft = yield* catalog
        .get(params.agentFlowId, params.revisionId)
        .pipe(Effect.mapError(failure));
      // Read the authorization before opening a browser, so an unauthorized
      // agent never costs the user a Chromium process.
      const authorization = draft.heads.verification;
      if (
        authorization === null ||
        authorization.revisionId !== params.revisionId ||
        authorization.status !== "authorized"
      ) {
        return yield* Effect.fail(
          new AgentFlowFailure({
            code: "agent_flow_conflict",
            diagnostics: [],
            message: `Revision ${params.revisionId} has no unspent Verification Run authorization. Ask the user to authorize verification in Agent View. (agent_flow_conflict)`,
          })
        );
      }
      const verification: AgentSessionVerification = {
        agentFlowId: params.agentFlowId,
        authorizationId: authorization.authorizationId,
        outcome: null,
        revisionId: params.revisionId,
        steps: draft.manifest.steps.map((step) => ({
          confirmation: step.confirmation,
          description: step.description,
          evidenceHash: step.evidence.hash,
          firstActionId: step.firstActionId,
          index: step.index,
          lastActionId: step.lastActionId,
          name: step.name,
        })),
        title: draft.manifest.title,
        // Verification asks for the declared Variables again: preconfigured
        // Teaching state must not be able to produce a false success.
        variables: draft.manifest.variables.map((variable) => ({
          name: variable.name,
          runtime: variable.runtime,
          secret: variable.secret,
          supplied: false,
        })),
      };
      const started = yield* session
        .start({
          activity: "run",
          clientName: params.clientName,
          clientVersion: params.clientVersion,
          domainScope: draft.manifest.domainScope,
          emulation: draft.manifest.emulation,
          operationId: params.operationId,
          // Verification opens where the user authorized it, in a browser
          // context of its own: only the URL crosses over, never Teaching's
          // cookies or storage.
          url: authorization.startingUrl ?? undefined,
          verification,
          viewport: draft.manifest.emulation.viewport,
        })
        .pipe(Effect.mapError(failure));
      // Spending the authorization can still lose a race with another writer.
      // The browser this call opened is closed rather than left running.
      return yield* catalog
        .startVerification({
          agentFlowId: params.agentFlowId,
          operationId: params.operationId,
          revisionId: params.revisionId,
          sessionId: started.id,
        })
        .pipe(
          Effect.mapError(failure),
          Effect.onError(() => session.close(started.id).pipe(Effect.ignore)),
          Effect.as(started)
        );
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
  agent_teaching_screenshot_get: (params) =>
    Effect.gen(function* readTeachingScreenshot() {
      const session = yield* AgentSession;
      return yield* session
        .teachingScreenshot(params.sessionId, params.screenshotId)
        .pipe(Effect.mapError(failure));
    }),
});

/** MCP's typed catalog and Teaching surface. */
export const McpAgentFlowLayer = McpServer.toolkit(AgentFlowTools).pipe(
  Layer.provide(AgentFlowToolHandlersLive)
);
