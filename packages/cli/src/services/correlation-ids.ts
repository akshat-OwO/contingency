import type { AgentRunId, AgentSessionId } from "@contingency/protocol";
import { Effect, Option } from "effect";

import type { AgentRunStoreService } from "./agent-run-store.ts";
import type { AgentSessionService } from "./agent-session.ts";

export interface ClaimedIds {
  readonly runId: AgentRunId | undefined;
  readonly sessionId: AgentSessionId | undefined;
}

export interface CorrelationSources {
  readonly sessions: Option.Option<AgentSessionService>;
  readonly runs: Option.Option<AgentRunStoreService>;
  /** Ids Contingency itself answered with, such as a started device session. */
  readonly issued?: ReadonlySet<string>;
}

/** Whether a lookup, when one is available, finds what it reads. */
const found = (lookup: Option.Option<Effect.Effect<unknown, unknown>>) =>
  Option.match(lookup, {
    onNone: () => Effect.succeed(false),
    onSome: (read) =>
      read.pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false)
      ),
  });

/**
 * The ids a request names that Contingency knows, for correlation fields.
 * A request's own text is not provenance: an id counts only once it was
 * issued here, names a live session, or names a persisted Run.
 */
export const knownIds = (
  { issued, runs, sessions }: CorrelationSources,
  { runId, sessionId }: ClaimedIds
): Effect.Effect<ClaimedIds> => {
  const known = <Id extends string>(
    id: Id | undefined,
    lookup: (id: Id) => Option.Option<Effect.Effect<unknown, unknown>>
  ): Effect.Effect<Id | undefined> =>
    id === undefined || issued?.has(id) === true
      ? Effect.succeed(id)
      : found(lookup(id)).pipe(
          Effect.map((exists) => (exists ? id : undefined))
        );
  return Effect.all({
    runId: known(runId, (id) =>
      runs.pipe(Option.map((store) => store.read(id)))
    ),
    sessionId: known(sessionId, (id) =>
      sessions.pipe(Option.map((service) => service.get(id)))
    ),
  });
};
