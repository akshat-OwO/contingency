import { Effect, Schema } from "effect";

import {
  AgentBrowserAction,
  AgentBrowserSnapshot,
  AgentElementRef,
  AgentSnapshotId,
  AgentActionOutcome,
} from "./agent-browser.ts";
import {
  AgentSessionController,
  AgentSessionId,
  OperationId,
} from "./agent-identifiers.ts";
import { DraftEmulation, Variable } from "./flow.ts";
import { optionalNullable } from "./optional-field.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** Variable names are shouty snake case, so `{{NAME}}` is unambiguous. */
const variableName = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
  Schema.isMinLength(1)
);

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

/** The content address of one stored screenshot's bytes. */
export const ScreenshotHash = Schema.String.check(
  Schema.isPattern(/^sha256-[a-f0-9]{64}$/u)
).pipe(Schema.brand("@contingency/ScreenshotHash"));
export type ScreenshotHash = typeof ScreenshotHash.Type;

/**
 * Where a revision stands. Teaching produces a `draft`; only a direct Agent
 * View approval after a successful Verification Run produces `approved`, and
 * that path is not part of the compile-and-save surface.
 */
export const AgentFlowRevisionStatus = Schema.Literals(["draft", "approved"]);
export type AgentFlowRevisionStatus = typeof AgentFlowRevisionStatus.Type;

/** A server-issued handle for one explicit user decision relayed over MCP. */
export const AgentPendingDecisionId = Schema.String.check(
  Schema.isPattern(/^pending-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u)
).pipe(Schema.brand("@contingency/AgentPendingDecisionId"));
export type AgentPendingDecisionId = typeof AgentPendingDecisionId.Type;

export const AgentPendingDecisionKind = Schema.Literals([
  "authorize_verification",
  "approve_flow",
]);
export type AgentPendingDecisionKind = typeof AgentPendingDecisionKind.Type;

export const AgentPendingDecisionChoice = Schema.Literals([
  "authorize",
  "approve",
  "refuse",
]);
export type AgentPendingDecisionChoice = typeof AgentPendingDecisionChoice.Type;

/**
 * One open decision the external agent may present in its conversation. The
 * id, kind, and exact target keep consent bound to the revision the user saw.
 */
export const AgentPendingDecision = Schema.Struct({
  agentFlowId: AgentFlowId,
  createdAt: nonEmptyString,
  kind: AgentPendingDecisionKind,
  pendingDecisionId: AgentPendingDecisionId,
  revisionId: AgentFlowRevisionId,
  /** Human-readable bounded scope for the agent to quote before asking. */
  scopeSummary: nonEmptyString,
  /** The session whose page supplies verification's starting URL, when live. */
  sessionId: Schema.NullOr(AgentSessionId),
});
export type AgentPendingDecision = typeof AgentPendingDecision.Type;

/** The durable audit record produced when the agent relays the user's choice. */
export const AgentPendingDecisionResolution = Schema.Struct({
  agentFlowId: AgentFlowId,
  decidedAt: nonEmptyString,
  decision: AgentPendingDecisionChoice,
  kind: AgentPendingDecisionKind,
  operationId: OperationId,
  pendingDecisionId: AgentPendingDecisionId,
  revisionId: AgentFlowRevisionId,
  userMessage: optionalNullable(nonEmptyString),
});
export type AgentPendingDecisionResolution =
  typeof AgentPendingDecisionResolution.Type;

export const AgentPendingDecisionResolve = Schema.Struct({
  decision: AgentPendingDecisionChoice,
  operationId: OperationId,
  pendingDecisionId: AgentPendingDecisionId,
  /** Audit context only. The server does not treat this as proof of consent. */
  userMessage: optionalNullable(nonEmptyString),
});
export type AgentPendingDecisionResolve =
  typeof AgentPendingDecisionResolve.Type;

// ---------------------------------------------------------------------------
// Demonstration and Teaching Feed
// ---------------------------------------------------------------------------

/** Redacted, bounded observation of one user input event during Takeover. */
export const CapturedUserInput = Schema.Struct({
  eventType: Schema.Literals([
    "char",
    "keyDown",
    "keyUp",
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
    "mouseWheel",
  ]),
  inputType: Schema.Literals(["keyboard", "mouse"]),
  key: optionalNullable(Schema.Literal("[user input]")),
  text: optionalNullable(Schema.Literal("[user input]")),
});
export type CapturedUserInput = typeof CapturedUserInput.Type;

/**
 * One browser action captured during Teaching, with who performed it and the
 * Page it left behind. Snapshot ids point into the Teaching Feed's snapshot
 * table so a feed with hundreds of actions does not repeat one document's
 * accessibility tree for each of them.
 */
export const CapturedAction = Schema.Struct({
  /** Agent actions, or a low-level input event captured during Takeover. */
  action: Schema.Union([
    AgentBrowserAction,
    Schema.Struct({
      input: CapturedUserInput,
      type: Schema.Literal("input"),
    }),
  ]),
  actor: AgentSessionController,
  at: nonEmptyString,
  description: nonEmptyString,
  detail: optionalNullable(Schema.String),
  id: nonEmptyString,
  outcome: AgentActionOutcome,
  snapshotAfter: Schema.NullOr(AgentSnapshotId),
  snapshotBefore: Schema.NullOr(AgentSnapshotId),
  urlAfter: Schema.String,
  urlBefore: Schema.String,
});
export type CapturedAction = typeof CapturedAction.Type;

/**
 * A reference to one best-effort-masked screenshot, as the Teaching Feed and
 * an Evidence Slice carry it. The bytes are stored once under their content
 * address and fetched on demand, so a projection over a whole Demonstration
 * stays small enough for the agent that has to read it
 * ([ADR 0032](../../../docs/adr/0032-external-agents-receive-a-bounded-teaching-feed.md)).
 */
export const TeachingScreenshot = Schema.Struct({
  capturedAt: nonEmptyString,
  contentHash: ScreenshotHash,
  format: Schema.Literal("png"),
  id: nonEmptyString,
  url: Schema.String,
});
export type TeachingScreenshot = typeof TeachingScreenshot.Type;

/**
 * One screenshot's bytes, fetched by reference for one screenshot at a time.
 * It is deliberately a superset of the reference rather than the same type:
 * every bulk projection carries references, and only this deliberate,
 * single-screenshot answer carries an image.
 */
export const TeachingScreenshotContent = Schema.Struct({
  ...TeachingScreenshot.fields,
  encoding: Schema.Literal("base64"),
  image: nonEmptyString,
});
export type TeachingScreenshotContent = typeof TeachingScreenshotContent.Type;

/** Fetch one Teaching screenshot's bytes from a live Agent Session. */
export const TeachingScreenshotGet = Schema.Struct({
  screenshotId: nonEmptyString,
  sessionId: AgentSessionId,
});
export type TeachingScreenshotGet = typeof TeachingScreenshotGet.Type;

/**
 * A screenshot reference inside a stored Evidence Slice. It adds where the
 * bytes live in the package, so a slice read outside a Teaching session still
 * resolves its screenshots.
 */
export const EvidenceScreenshot = Schema.Struct({
  ...TeachingScreenshot.fields,
  /** Relative to the Agent Flow's directory. */
  path: nonEmptyString,
});
export type EvidenceScreenshot = typeof EvidenceScreenshot.Type;

/**
 * A screenshot as older Catalog Roots stored it, with the PNG embedded in the
 * slice. Such a package still loads and still resolves its screenshots; it is
 * simply never written again
 * ([ADR 0033](../../../docs/adr/0033-agent-flow-catalog-stores-versioned-evidence-packages.md)).
 */
export const StoredEvidenceScreenshotV1 = Schema.Struct({
  capturedAt: nonEmptyString,
  encoding: Schema.Literal("base64"),
  format: Schema.Literal("png"),
  id: nonEmptyString,
  image: nonEmptyString,
  url: Schema.String,
});
export type StoredEvidenceScreenshotV1 = typeof StoredEvidenceScreenshotV1.Type;

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
  screenshots: Schema.Array(TeachingScreenshot),
  sessionId: AgentSessionId,
  /** The Browser Snapshots the actions reference, when the caller asked. */
  snapshots: Schema.Array(AgentBrowserSnapshot),
  urlTransitions: Schema.Array(UrlTransition),
  /** Variables demonstrated through private input, never their values. */
  variables: Schema.Array(Variable),
});
export type TeachingFeed = typeof TeachingFeed.Type;

/**
 * The documented budget for one screenshot inside a Teaching Feed or an
 * Evidence Slice: a reference of a few hundred characters, never an image. The
 * feed is bounded in size as well as in content, so its cost tracks how much
 * the user demonstrated rather than how large the Page's pixels are
 * ([ADR 0032](../../../docs/adr/0032-external-agents-receive-a-bounded-teaching-feed.md)).
 */
export const TEACHING_SCREENSHOT_BUDGET_CHARACTERS = 512;

export const TeachingFeedGet = Schema.Struct({
  includeSnapshots: optionalNullable(Schema.Boolean),
  sessionId: AgentSessionId,
});
export type TeachingFeedGet = typeof TeachingFeedGet.Type;

export const TeachingInstructionRecord = Schema.Struct({
  operationId: OperationId,
  sessionId: AgentSessionId,
  text: nonEmptyString,
});
export type TeachingInstructionRecord = typeof TeachingInstructionRecord.Type;

/**
 * Enter one private value during Teaching. The value exists only for this
 * browser action. Captured evidence stores `{{name}}` and the declaration.
 */
export const TeachingVariableInput = Schema.Struct({
  operationId: OperationId,
  /** Omit only in Agent View, where the currently focused control is used. */
  ref: optionalNullable(AgentElementRef),
  sessionId: AgentSessionId,
  value: nonEmptyString,
  variable: Schema.Struct({
    name: variableName,
    runtime: Variable.fields.runtime,
    secret: Variable.fields.secret,
  }),
});
export type TeachingVariableInput = typeof TeachingVariableInput.Type;

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
  schemaVersion: Schema.Literal(1),
  steps: Schema.Array(AgentStepProposal).check(Schema.isMinLength(1)),
  tags: optionalNullable(Schema.Array(nonEmptyString)),
  title: nonEmptyString,
  variables: optionalNullable(Schema.Array(Variable)),
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
  schemaVersion: Schema.Literal(2),
  screenshots: Schema.Array(EvidenceScreenshot),
  startedAt: nonEmptyString,
  urlTransitions: Schema.Array(UrlTransition),
});
export type EvidenceSlice = typeof EvidenceSlice.Type;

/** The first persisted slice version, before screenshots were stored once. */
export const StoredEvidenceSliceV1 = Schema.Struct({
  ...EvidenceSlice.fields,
  schemaVersion: Schema.Literal(1),
  screenshots: Schema.Array(StoredEvidenceScreenshotV1),
});
export type StoredEvidenceSliceV1 = typeof StoredEvidenceSliceV1.Type;

/** Every Evidence Slice version this release can read without rewriting it. */
export const StoredEvidenceSlice = Schema.Union([
  StoredEvidenceSliceV1,
  EvidenceSlice,
]);
export type StoredEvidenceSlice = typeof StoredEvidenceSlice.Type;

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
  /**
   * The inclusive span of captured action ids this objective was demonstrated
   * by. The manifest keeps it so a user correction — merge, split, rename, or
   * clarify — is expressed as another proposal over the same Demonstration
   * rather than as a hand edit of derived evidence.
   */
  firstActionId: nonEmptyString,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastActionId: nonEmptyString,
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
  schemaVersion: Schema.Literal(2),
  sourceSessionId: AgentSessionId,
  status: AgentFlowRevisionStatus,
  steps: Schema.Array(AgentStep).check(Schema.isMinLength(1)),
  tags: Schema.Array(nonEmptyString),
  title: nonEmptyString,
  variables: Schema.Array(Variable),
});
export type AgentFlowManifest = typeof AgentFlowManifest.Type;

/**
 * One Agent Step as older Catalog Roots stored it, before a Step carried the
 * demonstrated span it was cut from. The span is recovered from the Evidence
 * Slice the Step already names, so a manifest written by an earlier version
 * still opens for review
 * ([ADR 0033](../../../docs/adr/0033-agent-flow-catalog-stores-versioned-evidence-packages.md)).
 */
export const StoredAgentStepV1 = Schema.Struct({
  ...AgentStep.fields,
  firstActionId: Schema.optionalKey(nonEmptyString),
  lastActionId: Schema.optionalKey(nonEmptyString),
});
export type StoredAgentStepV1 = typeof StoredAgentStepV1.Type;

/** The first persisted package version, before Step spans were explicit. */
export const StoredAgentFlowManifestV1 = Schema.Struct({
  ...AgentFlowManifest.fields,
  schemaVersion: Schema.Literal(1),
  steps: Schema.Array(StoredAgentStepV1).check(Schema.isMinLength(1)),
});
export type StoredAgentFlowManifestV1 = typeof StoredAgentFlowManifestV1.Type;

/** Every package version this release can migrate without rewriting it. */
export const StoredAgentFlowManifest = Schema.Union([
  StoredAgentFlowManifestV1,
  AgentFlowManifest,
]);
export type StoredAgentFlowManifest = typeof StoredAgentFlowManifest.Type;

/**
 * Where one Verification Run stands. `authorized` is spent by starting the
 * Run, so one direct user gesture funds one attempt rather than unlimited
 * agent retries
 * ([ADR 0027](../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
 */
export const AgentFlowVerificationStatus = Schema.Literals([
  "authorized",
  "running",
  "passed",
  "failed",
]);
export type AgentFlowVerificationStatus =
  typeof AgentFlowVerificationStatus.Type;

/** The same evidence-backed verdict an agent gives an Interactive Run Step. */
export const AgentFlowVerificationAssessmentOutcome = Schema.Literals([
  "working",
  "not-working",
  "inconclusive",
  "blocked",
]);
export type AgentFlowVerificationAssessmentOutcome =
  typeof AgentFlowVerificationAssessmentOutcome.Type;

/** One Snapshot or attempt produced while verifying this exact Step. */
export const AgentFlowVerificationAssessmentEvidence = Schema.Struct({
  id: nonEmptyString,
  kind: Schema.Literals(["snapshot", "attempt"]),
});
export type AgentFlowVerificationAssessmentEvidence =
  typeof AgentFlowVerificationAssessmentEvidence.Type;

/** The durable evidence-backed verdict for one ordered draft Step. */
export const AgentFlowVerificationStepAssessment = Schema.Struct({
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  evidence: Schema.Array(AgentFlowVerificationAssessmentEvidence).check(
    Schema.isMinLength(1)
  ),
  explanation: nonEmptyString,
  outcome: AgentFlowVerificationAssessmentOutcome,
  stepIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  submittedAt: nonEmptyString,
});
export type AgentFlowVerificationStepAssessment =
  typeof AgentFlowVerificationStepAssessment.Type;

/**
 * One user authorization of one Verification Run, bound to one exact draft
 * revision. Any draft mutation replaces the draft head, and the authorization
 * does not travel with it: the changed draft must be authorized again.
 */
export const AgentFlowVerification = Schema.Struct({
  /** Ordered Step verdicts recorded before this Verification Run completed. */
  assessments: Schema.Array(AgentFlowVerificationStepAssessment).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  /** Identifies this authorization so a replayed approval names the same one. */
  authorizationId: nonEmptyString,
  authorizedAt: nonEmptyString,
  completedAt: Schema.NullOr(nonEmptyString),
  /** The exact draft revision this authorization covers, and nothing else. */
  revisionId: AgentFlowRevisionId,
  /** The Agent Session that performed the Run, once one started. */
  sessionId: Schema.NullOr(AgentSessionId),
  startedAt: Schema.NullOr(nonEmptyString),
  /**
   * The page Agent View was showing when the user authorized, so the
   * Verification Run opens where Teaching left off instead of `about:blank`.
   * It carries no cookies or storage: the Run still uses a fresh context. A
   * record written before Contingency carried it reads as `null`.
   */
  startingUrl: Schema.NullOr(nonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  status: AgentFlowVerificationStatus,
  /** The agent's account of why verification worked or failed. */
  summary: Schema.NullOr(nonEmptyString),
});
export type AgentFlowVerification = typeof AgentFlowVerification.Type;

/**
 * The stable identity record beside the revisions: which revision is the
 * current draft and which is approved. Draft writes name the draft head they
 * started from, so a stale write is a conflict rather than a silent merge.
 */
export const AgentFlowHeads = Schema.Struct({
  approvedRevisionId: Schema.NullOr(AgentFlowRevisionId),
  archived: Schema.Boolean,
  createdAt: nonEmptyString,
  decisionHistory: Schema.Array(AgentPendingDecisionResolution).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  draftRevisionId: Schema.NullOr(AgentFlowRevisionId),
  id: AgentFlowId,
  pendingDecisions: Schema.Array(AgentPendingDecision).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  schemaVersion: Schema.Literal(1),
  updatedAt: nonEmptyString,
  /**
   * The current draft's verification, or `null` when none is authorized. A
   * record written before Contingency verified drafts has no such key, and an
   * absent authorization is exactly no authorization, so it reads as `null`
   * rather than making the Agent Flow unreadable
   * ([ADR 0033](../../../docs/adr/0033-agent-flow-catalog-stores-versioned-evidence-packages.md)).
   */
  verification: Schema.NullOr(AgentFlowVerification).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
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
  operationId: OperationId,
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
  archived: optionalNullable(Schema.Boolean),
  host: optionalNullable(nonEmptyString),
  limit: optionalNullable(
    Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))
  ),
  query: optionalNullable(Schema.String),
  status: optionalNullable(AgentFlowRevisionStatus),
  tag: optionalNullable(nonEmptyString),
});
export type AgentFlowSearch = typeof AgentFlowSearch.Type;

export const AgentFlowSearchHit = Schema.Struct({
  agentFlowId: AgentFlowId,
  archived: Schema.Boolean,
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
  revisionId: optionalNullable(AgentFlowRevisionId),
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
  agentFlowId: optionalNullable(AgentFlowId),
  /**
   * The current draft head this proposal started from, or the approved head
   * when beginning a revision of an Approved Agent Flow. `null` is only for a
   * new stable identity. A write whose base is no longer current is a conflict
   * ([ADR 0028](../../../docs/adr/0028-approved-agent-flows-are-immutable-revisions.md)).
   */
  basedOnRevisionId: Schema.NullOr(AgentFlowRevisionId),
  draft: AgentFlowDraftProposal,
  operationId: OperationId,
  sessionId: AgentSessionId,
});
export type AgentFlowDraftSave = typeof AgentFlowDraftSave.Type;

/** The saved draft as Agent View and the session report it. */
export const AgentFlowDraftStep = Schema.Struct({
  confirmation: Schema.Boolean,
  description: nonEmptyString,
  evidenceHash: EvidenceHash,
  firstActionId: nonEmptyString,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastActionId: nonEmptyString,
  name: nonEmptyString,
});
export type AgentFlowDraftStep = typeof AgentFlowDraftStep.Type;

export const AgentFlowDraftRef = Schema.Struct({
  agentFlowId: AgentFlowId,
  revisionId: AgentFlowRevisionId,
  savedAt: nonEmptyString,
  steps: Schema.Array(AgentFlowDraftStep),
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

// ---------------------------------------------------------------------------
// Draft review, verification, and approval
// ---------------------------------------------------------------------------

/**
 * The bounded summary of one Agent Step's Evidence Slice, as Agent View shows
 * it during draft review. The captured action ids travel because they are the
 * boundaries a user splits a Step on; the accessibility trees and screenshots
 * behind them do not.
 */
export const AgentFlowEvidenceSummary = Schema.Struct({
  actions: Schema.Array(
    Schema.Struct({
      actor: AgentSessionController,
      description: nonEmptyString,
      id: nonEmptyString,
      outcome: AgentActionOutcome,
      urlAfter: Schema.String,
    })
  ),
  endedAt: nonEmptyString,
  hash: EvidenceHash,
  instructions: Schema.Array(nonEmptyString),
  screenshotCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  startedAt: nonEmptyString,
  stepIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  urlTransitionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type AgentFlowEvidenceSummary = typeof AgentFlowEvidenceSummary.Type;

/** One revision with the evidence summaries the draft review reads. */
export const AgentFlowRevisionDetail = Schema.Struct({
  evidence: Schema.Array(AgentFlowEvidenceSummary),
  revision: AgentFlowRevision,
});
export type AgentFlowRevisionDetail = typeof AgentFlowRevisionDetail.Type;

/**
 * A correction the external agent saves after the user confirms it in the MCP
 * conversation. It is the same shape the compiler produces, so merging,
 * splitting, renaming, clarifying, and editing Domain Scope all resolve to
 * Evidence Slices Contingency derives from the demonstrated spans, never to
 * agent-authored evidence
 * ([ADR 0025](../../../docs/adr/0025-agent-flow-is-compiled-from-a-demonstration.md)).
 */
export const AgentFlowDraftUpdate = Schema.Struct({
  agentFlowId: AgentFlowId,
  basedOnRevisionId: AgentFlowRevisionId,
  draft: AgentFlowDraftProposal,
  operationId: OperationId,
  sessionId: AgentSessionId,
});
export type AgentFlowDraftUpdate = typeof AgentFlowDraftUpdate.Type;

/**
 * A direct Agent View gesture authorizing one Verification Run of one exact
 * draft revision. There is deliberately no MCP tool for it: an agent may ask,
 * but it cannot authorize the activity it proposed.
 */
export const AgentFlowVerificationAuthorize = Schema.Struct({
  agentFlowId: AgentFlowId,
  operationId: OperationId,
  revisionId: AgentFlowRevisionId,
  /**
   * The Agent Session the user authorized from. Its current page becomes the
   * Verification Run's starting URL.
   */
  sessionId: optionalNullable(AgentSessionId),
});
export type AgentFlowVerificationAuthorize =
  typeof AgentFlowVerificationAuthorize.Type;

/** The external agent starting the Verification Run the user authorized. */
export const AgentFlowVerificationStart = Schema.Struct({
  agentFlowId: AgentFlowId,
  clientName: optionalNullable(nonEmptyString),
  clientVersion: optionalNullable(nonEmptyString),
  operationId: OperationId,
  revisionId: AgentFlowRevisionId,
});
export type AgentFlowVerificationStart = typeof AgentFlowVerificationStart.Type;

export const AgentFlowVerificationOutcome = Schema.Literals([
  "passed",
  "failed",
]);
export type AgentFlowVerificationOutcome =
  typeof AgentFlowVerificationOutcome.Type;

/** The agent's evidence-backed report of the Verification Run it performed. */
export const AgentFlowVerificationComplete = Schema.Struct({
  operationId: OperationId,
  outcome: AgentFlowVerificationOutcome,
  sessionId: AgentSessionId,
  summary: nonEmptyString,
});
export type AgentFlowVerificationComplete =
  typeof AgentFlowVerificationComplete.Type;

/**
 * A direct Agent View gesture turning one verified draft into the Approved
 * Agent Flow. Like authorization, it has no MCP tool
 * ([ADR 0028](../../../docs/adr/0028-approved-agent-flows-are-immutable-revisions.md)).
 */
export const AgentFlowApprove = Schema.Struct({
  agentFlowId: AgentFlowId,
  operationId: OperationId,
  revisionId: AgentFlowRevisionId,
});
export type AgentFlowApprove = typeof AgentFlowApprove.Type;

/**
 * Archive and deletion operate on the whole stable Agent Flow identity, so
 * they name both heads the user or agent read. A change to either head makes
 * the request stale.
 */
export const AgentFlowExpectedHeads = Schema.Struct({
  approvedRevisionId: AgentFlowHeads.fields.approvedRevisionId,
  archived: AgentFlowHeads.fields.archived,
  draftRevisionId: AgentFlowHeads.fields.draftRevisionId,
});
export type AgentFlowExpectedHeads = typeof AgentFlowExpectedHeads.Type;

export const AgentFlowArchive = Schema.Struct({
  agentFlowId: AgentFlowId,
  archived: Schema.Boolean,
  expectedHeads: AgentFlowExpectedHeads,
  operationId: OperationId,
});
export type AgentFlowArchive = typeof AgentFlowArchive.Type;

/** Permanent deletion exists only on Agent View's direct-user RPC boundary. */
export const AgentFlowDelete = Schema.Struct({
  agentFlowId: AgentFlowId,
  confirmation: Schema.Literal("permanently-delete"),
  expectedHeads: AgentFlowExpectedHeads,
  operationId: OperationId,
});
export type AgentFlowDelete = typeof AgentFlowDelete.Type;

export const AgentFlowDeleteResult = Schema.Struct({
  agentFlowId: AgentFlowId,
  deleted: Schema.Literal(true),
});
export type AgentFlowDeleteResult = typeof AgentFlowDeleteResult.Type;

/**
 * One Variable a Verification Run needs. The declaration travels; the literal
 * never does, so Agent View reports only whether a value has been supplied.
 */
export const AgentSessionVariableState = Schema.Struct({
  name: variableName,
  runtime: Variable.fields.runtime,
  secret: Variable.fields.secret,
  supplied: Schema.Boolean,
});
export type AgentSessionVariableState = typeof AgentSessionVariableState.Type;

/**
 * What an Agent Session is verifying. A Verification Run runs one exact draft
 * revision under one spent authorization, in a browser context that Teaching
 * never touched, with its runtime Variables supplied again.
 */
export const AgentSessionVerification = Schema.Struct({
  /** The Step currently accepting evidence, or `null` after a terminal verdict. */
  activeStepIndex: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  agentFlowId: AgentFlowId,
  assessments: Schema.Array(AgentFlowVerificationStepAssessment),
  authorizationId: nonEmptyString,
  outcome: Schema.NullOr(AgentFlowVerificationOutcome),
  revisionId: AgentFlowRevisionId,
  steps: Schema.Array(AgentFlowDraftStep),
  title: nonEmptyString,
  variables: Schema.Array(AgentSessionVariableState),
});
export type AgentSessionVerification = typeof AgentSessionVerification.Type;

/** Agent View supplying one runtime Variable value to a Verification Run. */
export const AgentSessionVariableSupply = Schema.Struct({
  name: variableName,
  operationId: OperationId,
  sessionId: AgentSessionId,
  value: nonEmptyString,
});
export type AgentSessionVariableSupply = typeof AgentSessionVariableSupply.Type;

/**
 * The agent entering a Variable the user supplied to this Run. It names the
 * Variable and the element, never the value: the literal stays inside
 * Contingency.
 */
export const AgentVariableEnter = Schema.Struct({
  name: variableName,
  operationId: OperationId,
  ref: AgentElementRef,
  sessionId: AgentSessionId,
});
export type AgentVariableEnter = typeof AgentVariableEnter.Type;
