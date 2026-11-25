import type { AgentRunId, AgentSessionId } from "@contingency/protocol";

export interface ClaimedIds {
  readonly runId: AgentRunId | undefined;
  readonly sessionId: AgentSessionId | undefined;
}

/** Enough for every session and Run one process touches, without growing forever. */
const KNOWN_LIMIT = 1024;

/** Ids a handler resolved or answered with, newest last. */
const known = new Set<string>();

/** Remembers ids a handler resolved, so later records may name them. */
export const rememberIds = (ids: ClaimedIds) => {
  for (const id of [ids.runId, ids.sessionId]) {
    if (id === undefined) {
      continue;
    }
    known.delete(id);
    known.add(id);
    if (known.size > KNOWN_LIMIT) {
      known.delete(known.values().next().value ?? id);
    }
  }
};

/**
 * The ids a request names that a handler already resolved, for correlation
 * fields. A request's own text is not provenance, and correlation never waits
 * on a lookup: an id no handler has resolved yet is omitted.
 */
export const knownIds = ({ runId, sessionId }: ClaimedIds): ClaimedIds => ({
  runId: runId !== undefined && known.has(runId) ? runId : undefined,
  sessionId:
    sessionId !== undefined && known.has(sessionId) ? sessionId : undefined,
});
