import type {
  AgentActionResult,
  AgentSessionSnapshot,
  AgentRunSummary,
  OperationId,
} from "@contingency/protocol";
import { Effect, Semaphore } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import { agentSessionError as error } from "./agent-session-error.ts";
import type {
  AgentSessionDomainError,
  AgentSessionError,
} from "./agent-session-error.ts";

export type AgentOperationKind =
  | "act"
  | "boundary"
  | "assess"
  | "task-update"
  | "task-assess"
  | "task-finding"
  | "variable-request"
  | "setup-variable-request"
  | "setup-variable-answer"
  | "close"
  | "complete"
  | "control"
  | "handoff"
  | "instruction"
  | "private-input"
  | "recording-discard"
  | "recording-rename"
  | "recording-start"
  | "recording-stop"
  | "start"
  | "takeover"
  | "variable-supply";

/** What a replayed operation answers with, discriminated so no cast is needed. */
type AgentOperationResult =
  | { readonly kind: "act"; readonly result: AgentActionResult }
  /**
   * A dispatched action whose outcome Contingency does not know. The browser
   * may already have performed it, so the id answers with the same refusal
   * rather than performing it a second time.
   */
  | { readonly error: AgentSessionError; readonly kind: "act-failure" }
  | { readonly kind: "run-summary"; readonly result: AgentRunSummary }
  | { readonly kind: "session"; readonly result: AgentSessionSnapshot };

interface ReplayRecord {
  readonly input: string;
  readonly kind: AgentOperationKind;
  readonly result: AgentOperationResult;
  readonly target: string;
}

/** Process-local receipts. Durable Teaching Recording receipts belong to their store.
 * No result is evicted: replay lasts for the lifetime of this Agent Session service.
 * Callers publish at their existing commit points, including inside interruption masks.
 */
export const makeSessionOperationLedger = () => {
  const registry = AtomRegistry.make();
  const mutationGate = Semaphore.makeUnsafe(1);
  // Entry lookup is O(1); updating a receipt does not copy every retained result.
  const entries = new Map<
    string,
    {
      readonly gate: Semaphore.Semaphore;
      readonly state: Atom.Writable<{
        readonly receipt: ReplayRecord | undefined;
        readonly actionInput: string | undefined;
      }>;
    }
  >();
  const entryFor = (key: string) => {
    const prior = entries.get(key);
    if (prior !== undefined) {
      return prior;
    }
    const entry = {
      gate: Semaphore.makeUnsafe(1),
      state: Atom.make<{
        readonly receipt: ReplayRecord | undefined;
        readonly actionInput: string | undefined;
      }>({ actionInput: undefined, receipt: undefined }).pipe(Atom.keepAlive),
    };
    entries.set(key, entry);
    return entry;
  };
  const serialize = <A, E, R>(
    id: OperationId | string | undefined,
    self: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() =>
      id === undefined ? self : entryFor(String(id)).gate.withPermit(self)
    );
  const remember = (
    operationId: OperationId | string | undefined,
    kind: AgentOperationKind,
    target: string,
    input: string,
    result: AgentOperationResult
  ): Effect.Effect<void> =>
    operationId === undefined
      ? Effect.void
      : Effect.sync(() =>
          registry.update(entryFor(String(operationId)).state, (current) => ({
            ...current,
            receipt: { input, kind, result, target },
          }))
        );

  const rememberSession = (
    operationId: OperationId | string | undefined,
    kind: AgentOperationKind,
    target: string,
    input: string,
    snapshot: AgentSessionSnapshot
  ): Effect.Effect<void> =>
    remember(operationId, kind, target, input, {
      kind: "session",
      result: snapshot,
    });

  const rememberRunSummary = (
    operationId: OperationId | string | undefined,
    target: string,
    input: string,
    summary: AgentRunSummary
  ): Effect.Effect<void> =>
    remember(operationId, "complete", target, input, {
      kind: "run-summary",
      result: summary,
    });

  /**
   * What a repeated operation id means. An identical request answers with
   * the recorded result and performs no effect; a different request under a
   * used id is a conflict rather than a second effect.
   */
  const replay = (
    operationId: OperationId | string | undefined,
    kind: AgentOperationKind,
    target: string,
    input: string
  ):
    | { readonly _tag: "conflict"; readonly error: AgentSessionDomainError }
    | { readonly _tag: "replay"; readonly result: AgentOperationResult }
    | undefined => {
    if (operationId === undefined) {
      return undefined;
    }
    const entry = entries.get(String(operationId));
    const prior =
      entry === undefined ? undefined : registry.get(entry.state).receipt;
    if (prior === undefined) {
      return undefined;
    }
    if (
      prior.kind === kind &&
      prior.target === target &&
      prior.input === input
    ) {
      return { _tag: "replay", result: prior.result };
    }
    return {
      _tag: "conflict",
      error: error(
        "agent_session_conflict",
        `Operation ${String(operationId)} was already used for a different ${prior.kind} request.`
      ),
    };
  };

  /** The replayed snapshot of a session mutation, if this id replays one. */
  const replaySession = (
    operationId: OperationId | string | undefined,
    kind: AgentOperationKind,
    target: string,
    input: string
  ):
    | { readonly _tag: "conflict"; readonly error: AgentSessionDomainError }
    | { readonly _tag: "replay"; readonly snapshot: AgentSessionSnapshot }
    | undefined => {
    const replayed = replay(operationId, kind, target, input);
    if (replayed === undefined || replayed._tag === "conflict") {
      return replayed;
    }
    return replayed.result.kind === "session"
      ? { _tag: "replay", snapshot: replayed.result.result }
      : {
          _tag: "conflict",
          error: error(
            "agent_session_conflict",
            `Operation ${String(operationId)} was already used for a browser action.`
          ),
        };
  };

  /**
   * Completing a Run is a mutation like any other: a transport retry answers
   * with the Run Summary the first call produced rather than finalizing a
   * second time over an already-closed browser.
   */
  const replayRunSummary = (
    operationId: OperationId | string | undefined,
    target: string,
    input: string
  ):
    | { readonly _tag: "conflict"; readonly error: AgentSessionDomainError }
    | { readonly _tag: "replay"; readonly summary: AgentRunSummary }
    | undefined => {
    const replayed = replay(operationId, "complete", target, input);
    if (replayed === undefined || replayed._tag === "conflict") {
      return replayed;
    }
    return replayed.result.kind === "run-summary"
      ? { _tag: "replay", summary: replayed.result.result }
      : {
          _tag: "conflict",
          error: error(
            "agent_session_conflict",
            `Operation ${String(operationId)} was already used for a session mutation.`
          ),
        };
  };

  const replayAction = (
    operationId: OperationId | string | undefined,
    kind: "act" | "private-input",
    target: string,
    input: string
  ): Effect.Effect<AgentActionResult, AgentSessionError> | undefined => {
    const prior = replay(operationId, kind, target, input);
    if (prior === undefined) {
      return undefined;
    }
    if (prior._tag === "conflict") {
      return Effect.fail(prior.error);
    }
    if (prior.result.kind === "act") {
      return Effect.succeed(prior.result.result);
    }
    if (prior.result.kind === "act-failure") {
      return Effect.fail(prior.result.error);
    }
    return Effect.fail(
      error(
        "agent_session_conflict",
        `Operation ${String(operationId)} was already used for a session mutation.`
      )
    );
  };
  /** Binding is lazy, so merely constructing an Effect cannot reserve an id.
   * Bindings survive interruption, just as action-attempt identity did before.
   */
  const serializeAction = <A, E, R>(
    operationId: OperationId | string | undefined,
    target: string,
    request: string,
    self: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | AgentSessionDomainError, R> =>
    Effect.suspend<A, E | AgentSessionDomainError, R>(() => {
      if (operationId === undefined) {
        return self;
      }
      const key = String(operationId);
      const input = JSON.stringify({ request, sessionId: target });
      const entry = entryFor(key);
      const prior = registry.get(entry.state).actionInput;
      if (prior !== undefined && prior !== input) {
        return Effect.fail(
          error(
            "agent_session_conflict",
            "This operation id is already bound to a different action attempt."
          )
        );
      }
      if (prior === undefined) {
        registry.update(entry.state, (current) => ({
          ...current,
          actionInput: input,
        }));
      }
      return serialize(operationId, self);
    });
  const session = <E, R>(
    id: OperationId | string | undefined,
    kind: AgentOperationKind,
    target: string,
    input: string,
    self: Effect.Effect<AgentSessionSnapshot, E, R>
  ) =>
    serialize(
      id,
      Effect.suspend<AgentSessionSnapshot, E | AgentSessionDomainError, R>(
        () => {
          const prior = replaySession(id, kind, target, input);
          if (prior?._tag === "conflict") {
            return Effect.fail(prior.error);
          }
          if (prior?._tag === "replay") {
            return Effect.succeed(prior.snapshot);
          }
          return self;
        }
      )
    );
  const summary = <E, R>(
    id: OperationId | string | undefined,
    target: string,
    input: string,
    self: Effect.Effect<AgentRunSummary, E, R>
  ) =>
    serialize(
      id,
      Effect.suspend<AgentRunSummary, E | AgentSessionDomainError, R>(() => {
        const prior = replayRunSummary(id, target, input);
        if (prior?._tag === "conflict") {
          return Effect.fail(prior.error);
        }
        if (prior?._tag === "replay") {
          return Effect.succeed(prior.summary);
        }
        return self;
      })
    );
  const action = <E, R>(
    id: OperationId | string | undefined,
    kind: "act" | "private-input",
    target: string,
    input: string,
    self: Effect.Effect<AgentActionResult, E, R>
  ) =>
    serializeAction(
      id,
      target,
      input,
      Effect.suspend<AgentActionResult, E | AgentSessionError, R>(
        () => replayAction(id, kind, target, input) ?? self
      )
    );
  // Workspace private input had no persistent action-attempt binding. Keep its
  // original receipt-conflict message while adding the shared same-id gate.
  const userAction = <E, R>(
    id: OperationId | string | undefined,
    target: string,
    input: string,
    self: Effect.Effect<AgentActionResult, E, R>
  ) =>
    serialize(
      id,
      Effect.suspend<AgentActionResult, E | AgentSessionError, R>(
        () => replayAction(id, "private-input", target, input) ?? self
      )
    );
  return {
    action,
    remember,
    rememberRunSummary,
    rememberSession,
    replayAction,
    replaySession,
    serializeMutation: <A, E, R>(self: Effect.Effect<A, E, R>) =>
      mutationGate.withPermit(self),
    session,
    summary,
    userAction,
  };
};
