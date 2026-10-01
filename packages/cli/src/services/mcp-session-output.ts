import {
  AgentRunSummary,
  AgentSessionCompact,
  AgentSessionSnapshot,
  AgentSessionView,
  compactAgentSession,
  optionalNullable,
} from "@contingency/protocol";
import type { AgentSessionView as SessionView } from "@contingency/protocol";
import { Effect, Schema } from "effect";

/**
 * The optional `view` parameter of every tool that answers with an Agent
 * Session. Absent or `full` keeps the complete snapshot.
 */
export const sessionViewParameter = optionalNullable(AgentSessionView);

/**
 * What a session-returning tool answers with. It is a union, and MCP output
 * schemas need an object root, so these tools publish no output schema; the
 * session shape is documented once in the protocol package instead of being
 * repeated in each tool definition.
 */
export const SessionResult = Schema.Union([
  AgentSessionSnapshot,
  AgentSessionCompact,
]);

/** Applies the caller's chosen view to a session-returning effect. */
export const inView =
  (view: SessionView | undefined) =>
  <E, R>(
    effect: Effect.Effect<AgentSessionSnapshot, E, R>
  ): Effect.Effect<AgentSessionSnapshot | AgentSessionCompact, E, R> =>
    view === "compact"
      ? // oxlint-disable-next-line unicorn/no-array-method-this-argument -- `Effect.map` is not an array method.
        Effect.map(effect, compactAgentSession)
      : effect;

/**
 * A field whose value is the JSON encoding of `schema` but whose shape is not
 * republished in the tool's output schema. Tools that return a session or Run
 * Summary at their root already publish no output schema; this gives the
 * tools that nest one the same policy, rather than inlining the same large
 * structure into several catalog entries (ADR 0045). Handlers encode the value
 * with {@link encodeUnpublished} before returning it.
 */
const unpublished = (description: string) =>
  Schema.Unknown.annotate({ description });

export const UnpublishedSession = unpublished(
  "An Agent Session in the same shape agent_session_get answers with, honouring the call's view."
);

export const UnpublishedRunSummary = unpublished(
  "The persisted Run Summary in the same shape agent_run_complete answers with."
);

const encodeSession = Schema.encodeEffect(SessionResult);
const encodeSummary = Schema.encodeEffect(AgentRunSummary);

/**
 * Encodes a value whose schema the catalog does not publish. A value that
 * fails its own schema is a defect in Contingency, not a client error.
 */
export const encodeUnpublishedSession = (
  value: AgentSessionSnapshot | AgentSessionCompact
) => Effect.orDie(encodeSession(value));

export const encodeUnpublishedRunSummary = (value: AgentRunSummary) =>
  Effect.orDie(encodeSummary(value));
