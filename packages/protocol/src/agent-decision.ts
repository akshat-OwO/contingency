import { Effect, Schema } from "effect";

import { AgentElementRef } from "./agent-browser.ts";
import { AgentSessionId, OperationId } from "./agent-identifiers.ts";
import { Variable } from "./emulation.ts";
import { optionalNullable } from "./optional-field.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/** Variable names are shouty snake case, so `{{NAME}}` is unambiguous. */
const variableName = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/u),
  Schema.isMinLength(1)
);

// ---------------------------------------------------------------------------
// Execution Boundary scope
// ---------------------------------------------------------------------------

/**
 * The exact hosts and explicit wildcard patterns (`*.example.com`) a session
 * may visit without pausing. A Flow Skill Run is scoped to the hosts its
 * package records, which are the hosts the Teaching Recording visited; a
 * package saved before Contingency stamped them falls back to the host of the
 * page the Run opens. Any other top-level document pauses for the user
 * ([ADR 0027](../../../docs/adr/0027-agent-authority-has-a-user-approved-execution-boundary.md)).
 */
export const DomainScope = Schema.Struct({
  hosts: Schema.Array(nonEmptyString).check(Schema.isMinLength(1)),
});
export type DomainScope = typeof DomainScope.Type;

// ---------------------------------------------------------------------------
// Relayed user decisions
// ---------------------------------------------------------------------------

/** A server-issued handle for one explicit user decision relayed over MCP. */
export const AgentPendingDecisionId = Schema.String.check(
  Schema.isPattern(/^pending-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u)
).pipe(Schema.brand("@contingency/AgentPendingDecisionId"));
export type AgentPendingDecisionId = typeof AgentPendingDecisionId.Type;

/**
 * The two decisions that protect execution. Both belong to a live Agent
 * Session: nothing here authorizes a stored artifact, because a Flow Skill is
 * verified by the user in the Workspace rather than approved over MCP
 * ([ADR 0039](../../../docs/adr/0039-flow-skills-are-learned-from-temporary-teaching-recordings.md)).
 */
export const AgentPendingDecisionKind = Schema.Literals([
  "boundary",
  "supply_variable",
]);
export type AgentPendingDecisionKind = typeof AgentPendingDecisionKind.Type;

export const AgentPendingDecisionChoice = Schema.Literals([
  "allow",
  "supply",
  "refuse",
]);
export type AgentPendingDecisionChoice = typeof AgentPendingDecisionChoice.Type;

/**
 * One open decision the external agent may present in its conversation. The
 * id, kind, and exact target keep consent bound to what the user saw: the
 * exact paused Execution Boundary for a `boundary` decision, and the exact
 * Variable for a `supply_variable` one.
 */
export const AgentPendingDecision = Schema.Struct({
  /** The paused Execution Boundary this decision releases, for `boundary`. */
  boundaryId: Schema.NullOr(nonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  createdAt: nonEmptyString,
  kind: AgentPendingDecisionKind,
  pendingDecisionId: AgentPendingDecisionId,
  /** Human-readable bounded scope for the agent to quote before asking. */
  scopeSummary: nonEmptyString,
  /** The session this decision belongs to. */
  sessionId: Schema.NullOr(AgentSessionId),
  /**
   * The runtime Variable this decision supplies, for `supply_variable`. The
   * declaration travels so the agent can name it and say whether it is secret;
   * the literal never does.
   */
  variable: Schema.NullOr(
    Schema.Struct({ name: variableName, secret: Schema.Boolean })
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
});
export type AgentPendingDecision = typeof AgentPendingDecision.Type;

/** The durable audit record produced when the agent relays the user's choice. */
export const AgentPendingDecisionResolution = Schema.Struct({
  boundaryId: Schema.NullOr(nonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
  decidedAt: nonEmptyString,
  decision: AgentPendingDecisionChoice,
  kind: AgentPendingDecisionKind,
  operationId: OperationId,
  pendingDecisionId: AgentPendingDecisionId,
  userMessage: optionalNullable(nonEmptyString),
  /**
   * The Variable a `supply_variable` decision named. Secret Variable names are
   * audited; their values never are.
   */
  variableName: Schema.NullOr(variableName).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null))
  ),
});
export type AgentPendingDecisionResolution =
  typeof AgentPendingDecisionResolution.Type;

export const AgentPendingDecisionResolve = Schema.Struct({
  decision: AgentPendingDecisionChoice,
  operationId: OperationId,
  pendingDecisionId: AgentPendingDecisionId,
  /** Audit context only. The server does not treat this as proof of consent. */
  userMessage: optionalNullable(nonEmptyString),
  /**
   * The literal the user supplied for a `supply_variable` decision. It stays
   * inside Contingency: it is never published, persisted, or audited.
   */
  value: optionalNullable(nonEmptyString),
});
export type AgentPendingDecisionResolve =
  typeof AgentPendingDecisionResolve.Type;

// ---------------------------------------------------------------------------
// Runtime Variables
// ---------------------------------------------------------------------------

/**
 * One Variable a Run needs. The declaration travels; the literal never does,
 * so the Workspace reports only whether a value has been supplied.
 */
export const AgentSessionVariableState = Schema.Struct({
  name: variableName,
  runtime: Variable.fields.runtime,
  secret: Variable.fields.secret,
  supplied: Schema.Boolean,
});
export type AgentSessionVariableState = typeof AgentSessionVariableState.Type;

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

// ---------------------------------------------------------------------------
// Catalog Root
// ---------------------------------------------------------------------------

/**
 * The directory that bounds Flow Skill discovery and Teaching Recording
 * storage for one MCP process. Contingency never scans a user-global catalog.
 */
export const AgentCatalogInfo = Schema.Struct({
  flowSkillCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  root: nonEmptyString,
});
export type AgentCatalogInfo = typeof AgentCatalogInfo.Type;

export const AgentCatalogSelect = Schema.Struct({
  operationId: OperationId,
  root: nonEmptyString,
});
export type AgentCatalogSelect = typeof AgentCatalogSelect.Type;

/** One Flow Skill package the selected Catalog Root holds. */
export const FlowSkillListEntry = Schema.Struct({
  /** Declared in SKILL.md frontmatter; the task and when to run it. */
  description: Schema.String,
  /**
   * The declared `{{placeholder}}` inputs, in frontmatter order. A description
   * is present only when SKILL.md declared the input in its mapping form.
   */
  inputs: Schema.Array(
    Schema.Struct({
      description: Schema.optional(nonEmptyString),
      name: nonEmptyString,
    })
  ),
  name: nonEmptyString,
  /** The Flow Skill directory, absolute. */
  path: nonEmptyString,
  /** How many numbered steps the procedure carries. */
  stepCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type FlowSkillListEntry = typeof FlowSkillListEntry.Type;

export const FlowSkillList = Schema.Struct({
  catalogRoot: nonEmptyString,
  flowSkills: Schema.Array(FlowSkillListEntry),
});
export type FlowSkillList = typeof FlowSkillList.Type;
