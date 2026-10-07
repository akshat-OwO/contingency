import {
  AgentActionResult,
  AgentActSequenceResult,
  AgentRunSummary,
  AgentSessionCompact,
  DraftEmulation,
  AgentSessionView,
  RunSessionSnapshot,
  SessionEvent,
  TeachingSessionSnapshot,
  compactAgentSession,
  optionalNullable,
} from "@contingency/protocol";
import type {
  AgentSessionView as SessionView,
  AgentSessionSnapshot,
} from "@contingency/protocol";
import { Effect, Schema } from "effect";

import { AgentSession } from "./agent-session.ts";

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
const eventFields = {
  events: Schema.optional(Schema.Array(SessionEvent)),
  eventsTruncated: Schema.optional(Schema.Boolean),
};
export const SessionResult = Schema.Union([
  Schema.Struct({ ...TeachingSessionSnapshot.fields, ...eventFields }),
  Schema.Struct({ ...RunSessionSnapshot.fields, ...eventFields }),
  Schema.Struct({ ...AgentSessionCompact.fields, ...eventFields }),
]);

/** The immediate user-visible action after any successful session start. */
export const WorkspaceLinkGuidance = Schema.Struct({
  nextAction: Schema.String,
});

export const workspaceLinkGuidance = (viewUrl: string) => ({
  nextAction: `Your next response must be a visible assistant text message containing this exact link: [Open Workspace](${viewUrl}). Send that message before calling another tool so the user can watch the journey. A link in internal thinking or tool output does not count. After sending the message, continue the session.`,
});

/** Start-only guidance stays outside the persisted session protocol. */
export const SessionStartResult = Schema.Union([
  Schema.Struct({
    ...WorkspaceLinkGuidance.fields,
    ...TeachingSessionSnapshot.fields,
  }),
  Schema.Struct({
    ...WorkspaceLinkGuidance.fields,
    ...RunSessionSnapshot.fields,
  }),
  Schema.Struct({
    ...WorkspaceLinkGuidance.fields,
    ...AgentSessionCompact.fields,
  }),
]);

/** Applies the caller's chosen view to a session-returning effect. */
export const inView =
  (view: SessionView | undefined) =>
  <E, R>(effect: Effect.Effect<AgentSessionSnapshot, E, R>) =>
    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.flatMap composes effects.
    Effect.flatMap(effect, (snapshot) =>
      Effect.gen(function* presentSession() {
        const service = yield* AgentSession;
        const state = yield* service
          .sessionEvents(snapshot.id)
          .pipe(Effect.orDie);
        const result =
          view === "compact" ? compactAgentSession(snapshot) : snapshot;
        return { ...result, eventCursor: state.eventCursor };
      })
    );

/** Preserve the chosen view and put the link-sharing reminder first. */
export const inStartView =
  (view: SessionView | undefined) =>
  <E, R>(effect: Effect.Effect<AgentSessionSnapshot, E, R>) =>
    inView(view)(effect).pipe(
      Effect.map((session) => ({
        ...workspaceLinkGuidance(session.viewUrl),
        ...session,
      }))
    );

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

export const UnpublishedActionResult = unpublished(
  "The AgentActionResult returned by agent_browser_act: entry, optional intervention, snapshot, and url."
);

export const UnpublishedSequenceResult = unpublished(
  "Ordered actions with operationId, entry, and intervention (as in agent_browser_act); a final snapshot and url; stopped is null or contains index, reason, code, and message."
);

export const UnpublishedSession = unpublished(
  "An Agent Session in the same shape agent_session_get answers with, honouring the call's view."
);

export const UnpublishedRunSummary = unpublished(
  "The persisted Run Summary in the same shape agent_run_complete answers with."
);

export const UnpublishedEmulation = unpublished(
  "The Emulation the recording was demonstrated under. A Dry Run reproduces it."
);

const encodeAction = Schema.encodeEffect(AgentActionResult);
const encodeSequence = Schema.encodeEffect(AgentActSequenceResult);
const encodeSession = Schema.encodeEffect(SessionResult);
const encodeSummary = Schema.encodeEffect(AgentRunSummary);
const encodeEmulation = Schema.encodeEffect(DraftEmulation);

/**
 * Encodes a value whose schema the catalog does not publish. A value that
 * fails its own schema is a defect in Contingency, not a client error.
 */
export const encodeUnpublishedSession = (
  value: AgentSessionSnapshot | AgentSessionCompact
) =>
  Effect.gen(function* encodeSessionWithCursor() {
    const service = yield* AgentSession;
    const { eventCursor } = yield* service
      .sessionEvents(value.id)
      .pipe(Effect.orDie);
    return yield* Effect.orDie(encodeSession({ ...value, eventCursor }));
  });

export const encodeUnpublishedRunSummary = (value: AgentRunSummary) =>
  Effect.orDie(encodeSummary(value));

export const encodeUnpublishedEmulation = (value: DraftEmulation) =>
  Effect.orDie(encodeEmulation(value));

export const encodeUnpublishedActionResult = (value: AgentActionResult) =>
  Effect.orDie(encodeAction(value));

export const encodeUnpublishedSequenceResult = (
  value: AgentActSequenceResult
) => Effect.orDie(encodeSequence(value));
