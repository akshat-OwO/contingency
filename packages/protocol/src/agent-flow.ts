import { Schema } from "effect";

import {
  AgentBrowserAction,
  AgentBrowserSnapshot,
  AgentSnapshotId,
  AgentActionOutcome,
} from "./agent-browser.ts";
import {
  AgentSessionController,
  AgentSessionId,
  OperationId,
} from "./agent-identifiers.ts";
import { DraftEmulation, Variable } from "./flow.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/**
 * The stable identity of one Agent Flow. It spans every revision, so a Suite
 * or a later search names the journey rather than one immutable package
 * ([ADR 0028](../../../docs/adr/0028-approved-agent-flows-are-immutable-revisions.md)).
 */
export const AgentFlowId = Schema.String.check(
  Schema.isPattern(/^flow-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
).pipe(Schema.brand("@contingency/AgentFlowId"));
export type AgentFlowId = typeof AgentFlowId.Type;

/** One immutable, schema-versioned revision of an Agent Flow. */
export const AgentFlowRevisionId = Schema.String.check(
  Schema.isPattern(/^rev-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
).pipe(Schema.brand("@contingency/AgentFlowRevisionId"));
export type AgentFlowRevisionId = typeof AgentFlowRevisionId.Type;

/** The content address of one Evidence Slice file. */
export const EvidenceHash = Schema.String.check(
  Schema.isPattern(/^sha256-[a-f0-9]{64}$/u)
).pipe(Schema.brand("@contingency/EvidenceHash"));
export type EvidenceHash = typeof EvidenceHash.Type;

/**
 * Where a revision stands. Teaching produces a `draft`; only a direct Agent
 * View approval after a successful Verification Run produces `approved`, and
 * that path is not part of the compile-and-save surface.
 */
export const AgentFlowRevisionStatus = Schema.Literals(["draft", "approved"]);
export type AgentFlowRevisionStatus = typeof AgentFlowRevisionStatus.Type;

// ---------------------------------------------------------------------------
// Demonstration and Teaching Feed
// ---------------------------------------------------------------------------

/**
 * One browser action captured during Teaching, with who performed it and the
 * Page it left behind. Snapshot ids point into the Teaching Feed's snapshot
 * table so a feed with hundreds of actions does not repeat one document's
 * accessibility tree for each of them.
 */
export const CapturedAction = Schema.Struct({
  action: AgentBrowserAction,
  actor: AgentSessionController,
  at: nonEmptyString,
  description: nonEmptyString,
  detail: Schema.optional(Schema.String),
  id: nonEmptyString,
  outcome: AgentActionOutcome,
  snapshotAfter: Schema.NullOr(AgentSnapshotId),
  snapshotBefore: Schema.NullOr(AgentSnapshotId),
  urlAfter: Schema.String,
  urlBefore: Schema.String,
});
export type CapturedAction = typeof CapturedAction.Type;

/** What the user told the agent to do, as the agent relayed it. */
export const TeachingInstruction = Schema.Struct({
  at: nonEmptyString,
  id: nonEmptyString,
  text: nonEmptyString,
});
export type TeachingInstruction = typeof TeachingInstruction.Type;

/** One observed change of the Page's URL, attributed to an action when known. */
export const UrlTransition = Schema.Struct({
  actionId: Schema.NullOr(nonEmptyString),
  at: nonEmptyString,
  from: Schema.String,
  to: Schema.String,
});
export type UrlTransition = typeof UrlTransition.Type;

/**
 * The bounded view of a Demonstration the external agent compiles from
 * ([ADR 0032](../../../docs/adr/0032-external-agents-receive-a-bounded-teaching-feed.md)).
 * It carries instructions, captured actions, Browser Snapshots, and URL
 * transitions. Cookies, authorization headers, network bodies, video, and the
 * full Trace never appear here.
 */
export const TeachingFeed = Schema.Struct({
  actions: Schema.Array(CapturedAction),
  instructions: Schema.Array(TeachingInstruction),
  /** Exact hosts the Demonstration visited: the proposed Domain Scope. */
  observedHosts: Schema.Array(nonEmptyString),
  sessionId: AgentSessionId,
  /** The Browser Snapshots the actions reference, when the caller asked. */
  snapshots: Schema.Array(AgentBrowserSnapshot),
  urlTransitions: Schema.Array(UrlTransition),
});
export type TeachingFeed = typeof TeachingFeed.Type;

export const TeachingFeedGet = Schema.Struct({
  includeSnapshots: Schema.optional(Schema.Boolean),
  sessionId: AgentSessionId,
});
export type TeachingFeedGet = typeof TeachingFeedGet.Type;

export const TeachingInstructionRecord = Schema.Struct({
  operationId: OperationId,
  sessionId: AgentSessionId,
  text: nonEmptyString,
});
export type TeachingInstructionRecord = typeof TeachingInstructionRecord.Type;

// ---------------------------------------------------------------------------
// Compiler input
// ---------------------------------------------------------------------------

/**
 * The exact hosts and explicit wildcard patterns (`*.example.com`) an Agent
 * Flow may visit. Teaching proposes the observed hosts; the compiler may only
 * declare entries that cover them.
 */
export const DomainScope = Schema.Struct({
  hosts: Schema.Array(nonEmptyString).check(Schema.isMinLength(1)),
});
export type DomainScope = typeof DomainScope.Type;

/**
 * One objective the agent proposes, backed by an inclusive span of captured
 * action ids. Contingency derives the Evidence Slice from that span; the agent
 * names the boundary, not the evidence
 * ([ADR 0025](../../../docs/adr/0025-agent-flow-is-compiled-from-a-demonstration.md)).
 */
export const AgentStepProposal = Schema.Struct({
  confirmation: Schema.Boolean,
  description: nonEmptyString,
  firstActionId: nonEmptyString,
  lastActionId: nonEmptyString,
  name: nonEmptyString,
});
export type AgentStepProposal = typeof AgentStepProposal.Type;

/** The compiler's whole output for one draft revision. */
export const AgentFlowDraftProposal = Schema.Struct({
  description: nonEmptyString,
  domainScope: DomainScope,
  steps: Schema.Array(AgentStepProposal).check(Schema.isMinLength(1)),
  tags: Schema.optional(Schema.Array(nonEmptyString)),
  title: nonEmptyString,
  variables: Schema.optional(Schema.Array(Variable)),
});
export type AgentFlowDraftProposal = typeof AgentFlowDraftProposal.Type;

/** One structured reason compiler output was refused. */
export const AgentFlowDiagnostic = Schema.Struct({
  code: nonEmptyString,
  message: nonEmptyString,
  /** Where in the proposal the problem is, as a JSON path. */
  path: Schema.Array(Schema.Union([Schema.String, Schema.Int])),
});
export type AgentFlowDiagnostic = typeof AgentFlowDiagnostic.Type;

// ---------------------------------------------------------------------------
// Persisted revision package
// ---------------------------------------------------------------------------

/**
 * The evidence behind one Agent Step: the user instructions in force, the
 * captured actions, the Browser Snapshots before and after, the URL
 * transitions, and timing. Derived by Contingency from the demonstrated span,
 * immutable, and content-addressed.
 */
export const EvidenceSlice = Schema.Struct({
  actions: Schema.Array(CapturedAction),
  after: Schema.NullOr(AgentBrowserSnapshot),
  before: Schema.NullOr(AgentBrowserSnapshot),
  endedAt: nonEmptyString,
  instructions: Schema.Array(TeachingInstruction),
  schemaVersion: Schema.Literal(1),
  startedAt: nonEmptyString,
  step: Schema.Struct({
    description: nonEmptyString,
    name: nonEmptyString,
  }),
  urlTransitions: Schema.Array(UrlTransition),
});
export type EvidenceSlice = typeof EvidenceSlice.Type;

export const EvidenceSliceRef = Schema.Struct({
  hash: EvidenceHash,
  /** Relative to the Agent Flow's directory. */
  path: nonEmptyString,
});
export type EvidenceSliceRef = typeof EvidenceSliceRef.Type;

export const AgentStep = Schema.Struct({
  confirmation: Schema.Boolean,
  description: nonEmptyString,
  evidence: EvidenceSliceRef,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: nonEmptyString,
});
export type AgentStep = typeof AgentStep.Type;

/** Which MCP client compiled the revision. Model metadata is never verified. */
export const AgentFlowCompiler = Schema.Struct({
  clientName: nonEmptyString,
  clientVersion: nonEmptyString,
});
export type AgentFlowCompiler = typeof AgentFlowCompiler.Type;

/**
 * The manifest of one revision package
 * ([ADR 0033](../../../docs/adr/0033-agent-flow-catalog-stores-versioned-evidence-packages.md)).
 */
export const AgentFlowManifest = Schema.Struct({
  agentFlowId: AgentFlowId,
  basedOnRevisionId: Schema.NullOr(AgentFlowRevisionId),
  compiler: AgentFlowCompiler,
  createdAt: nonEmptyString,
  description: nonEmptyString,
  domainScope: DomainScope,
  emulation: DraftEmulation,
  revisionId: AgentFlowRevisionId,
  schemaVersion: Schema.Literal(1),
  sourceSessionId: AgentSessionId,
  status: AgentFlowRevisionStatus,
  steps: Schema.Array(AgentStep).check(Schema.isMinLength(1)),
  tags: Schema.Array(nonEmptyString),
  title: nonEmptyString,
  variables: Schema.Array(Variable),
});
export type AgentFlowManifest = typeof AgentFlowManifest.Type;

/**
 * The stable identity record beside the revisions: which revision is the
 * current draft and which is approved. Draft writes name the draft head they
 * started from, so a stale write is a conflict rather than a silent merge.
 */
export const AgentFlowHeads = Schema.Struct({
  approvedRevisionId: Schema.NullOr(AgentFlowRevisionId),
  archived: Schema.Boolean,
  createdAt: nonEmptyString,
  draftRevisionId: Schema.NullOr(AgentFlowRevisionId),
  id: AgentFlowId,
  schemaVersion: Schema.Literal(1),
  updatedAt: nonEmptyString,
});
export type AgentFlowHeads = typeof AgentFlowHeads.Type;

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const AgentCatalogInfo = Schema.Struct({
  agentFlowCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  root: nonEmptyString,
});
export type AgentCatalogInfo = typeof AgentCatalogInfo.Type;

export const AgentCatalogSelect = Schema.Struct({
  root: nonEmptyString,
});
export type AgentCatalogSelect = typeof AgentCatalogSelect.Type;

/**
 * Deterministic filters plus one local full-text query over titles,
 * descriptions, tags, and Agent Step names and descriptions. No filter returns
 * every live head, drafts included and labelled: a draft match is offered for
 * continuation, never mistaken for approved coverage.
 */
export const AgentFlowSearch = Schema.Struct({
  host: Schema.optional(nonEmptyString),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))
  ),
  query: Schema.optional(Schema.String),
  status: Schema.optional(AgentFlowRevisionStatus),
  tag: Schema.optional(nonEmptyString),
});
export type AgentFlowSearch = typeof AgentFlowSearch.Type;

export const AgentFlowSearchHit = Schema.Struct({
  agentFlowId: AgentFlowId,
  createdAt: nonEmptyString,
  description: nonEmptyString,
  hosts: Schema.Array(nonEmptyString),
  /** Which searchable fields the query matched, for the agent's explanation. */
  matchedFields: Schema.Array(nonEmptyString),
  revisionId: AgentFlowRevisionId,
  score: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: AgentFlowRevisionStatus,
  stepCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  tags: Schema.Array(nonEmptyString),
  title: nonEmptyString,
});
export type AgentFlowSearchHit = typeof AgentFlowSearchHit.Type;

export const AgentFlowSearchResult = Schema.Struct({
  catalogRoot: nonEmptyString,
  hits: Schema.Array(AgentFlowSearchHit),
});
export type AgentFlowSearchResult = typeof AgentFlowSearchResult.Type;

export const AgentFlowGet = Schema.Struct({
  agentFlowId: AgentFlowId,
  /** A specific revision; the current draft head when omitted. */
  revisionId: Schema.optional(AgentFlowRevisionId),
});
export type AgentFlowGet = typeof AgentFlowGet.Type;

export const AgentFlowRevision = Schema.Struct({
  catalogRoot: nonEmptyString,
  heads: AgentFlowHeads,
  manifest: AgentFlowManifest,
  /** The revision package directory, absolute. */
  path: nonEmptyString,
});
export type AgentFlowRevision = typeof AgentFlowRevision.Type;

export const AgentFlowDraftSave = Schema.Struct({
  /** Revise an existing Agent Flow; a new identity is minted when omitted. */
  agentFlowId: Schema.optional(AgentFlowId),
  /**
   * The draft head this proposal started from: `null` for a new draft. A
   * write whose base is no longer the head is a conflict
   * ([ADR 0028](../../../docs/adr/0028-approved-agent-flows-are-immutable-revisions.md)).
   */
  basedOnRevisionId: Schema.NullOr(AgentFlowRevisionId),
  draft: AgentFlowDraftProposal,
  operationId: OperationId,
  sessionId: AgentSessionId,
});
export type AgentFlowDraftSave = typeof AgentFlowDraftSave.Type;

/** The saved draft as Agent View and the session report it. */
export const AgentFlowDraftRef = Schema.Struct({
  agentFlowId: AgentFlowId,
  revisionId: AgentFlowRevisionId,
  savedAt: nonEmptyString,
  title: nonEmptyString,
});
export type AgentFlowDraftRef = typeof AgentFlowDraftRef.Type;

/** What a Teaching session has captured so far, for Agent View. */
export const TeachingProgress = Schema.Struct({
  actionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  draft: Schema.NullOr(AgentFlowDraftRef),
  instructionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type TeachingProgress = typeof TeachingProgress.Type;
