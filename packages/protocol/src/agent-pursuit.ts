import { Schema } from "effect";

import {
  AgentBrowserSnapshot,
  AgentExecutionBoundary,
  AgentTimelineEntry,
} from "./agent-browser.ts";
import { AgentSessionId, OperationId } from "./agent-identifiers.ts";
import { FlowSkillName } from "./flow-skill-identifiers.ts";
import { optionalNullable } from "./optional-field.ts";

const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/**
 * A Pursuit's fixed budget. The agent may lower either limit for one call but
 * never raise it, so a call stays inside the 50-second wait clamp with room for
 * one final action's actionability wait
 * ([ADR 0057](../../../docs/adr/0057-system-one-pursues-delegated-sub-goals.md)).
 */
export const PURSUIT_LIMITS = {
  maxActions: 8,
  timeoutMs: 40_000,
} as const;

/** One sub-goal the external agent hands down to System One. */
export const AgentBrowserPursue = Schema.Struct({
  /** What the Page must visibly show for the sub-goal to hold. */
  doneWhen: nonEmptyString.check(Schema.isMaxLength(500)),
  /** Whose inputs and Variables the Pursuit may use. Absent means all. */
  flowSkillName: optionalNullable(FlowSkillName),
  /** The sub-goal, phrased as one Flow Skill step. */
  goal: nonEmptyString.check(Schema.isMaxLength(1000)),
  /** Pause every mutating action of this Pursuit for user Confirmation. */
  irreversible: optionalNullable(Schema.Boolean),
  maxActions: optionalNullable(
    Schema.Int.check(
      Schema.isBetween({ maximum: PURSUIT_LIMITS.maxActions, minimum: 1 })
    )
  ),
  operationId: OperationId,
  sessionId: AgentSessionId,
  timeoutMs: optionalNullable(
    Schema.Int.check(
      Schema.isBetween({
        maximum: PURSUIT_LIMITS.timeoutMs,
        minimum: 1000,
      })
    )
  ),
});
export type AgentBrowserPursue = typeof AgentBrowserPursue.Type;

/** How a Pursuit ended. Each stop condition maps to exactly one ending. */
export const AgentPursuitEnding = Schema.Literals([
  "done",
  "blocked",
  "unsure",
  "paused",
  "needs-input",
]);
export type AgentPursuitEnding = typeof AgentPursuitEnding.Type;

/** The probability System One gave each chosen answer behind one action. */
export const AgentPursuitConfidence = Schema.Struct({
  operation: Schema.Finite,
  target: Schema.Finite,
  value: Schema.NullOr(Schema.Finite),
});
export type AgentPursuitConfidence = typeof AgentPursuitConfidence.Type;

/**
 * A finished Pursuit as the Run keeps it, so a reviewer can tell model-chosen
 * attempts from the agent's own. `attemptIds` join the Run's timeline.
 */
export const AgentPursuitRecord = Schema.Struct({
  actions: Schema.Array(
    Schema.Struct({
      attemptId: nonEmptyString,
      confidence: AgentPursuitConfidence,
    })
  ),
  doneWhen: nonEmptyString,
  endedAt: nonEmptyString,
  ending: AgentPursuitEnding,
  goal: nonEmptyString,
  operationId: OperationId,
  reason: nonEmptyString,
});
export type AgentPursuitRecord = typeof AgentPursuitRecord.Type;

export const AgentPursuitResult = Schema.Struct({
  /** Every attempt that reached the timeline, in order. */
  actions: Schema.Array(
    Schema.Struct({
      confidence: AgentPursuitConfidence,
      entry: AgentTimelineEntry,
      operationId: OperationId,
      /** The Variable entered by name, when the value was one. */
      variable: Schema.NullOr(nonEmptyString),
    })
  ),
  ending: AgentPursuitEnding,
  /** The Execution Boundary a `paused` ending waits on, if one. */
  intervention: Schema.NullOr(AgentExecutionBoundary),
  /** The Variable a `needs-input` ending asks the agent to request. */
  missingVariable: Schema.NullOr(
    Schema.Struct({ flowSkillName: FlowSkillName, name: nonEmptyString })
  ),
  reason: nonEmptyString,
  /** The Page as the Pursuit last read it. */
  snapshot: Schema.NullOr(AgentBrowserSnapshot),
  url: Schema.NullOr(Schema.String),
});
export type AgentPursuitResult = typeof AgentPursuitResult.Type;
