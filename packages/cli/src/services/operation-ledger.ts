import { Effect, Result, Semaphore } from "effect";

/**
 * What a caller asks for under one operation id. Two requests are the same
 * request only when the kind, the target, and the input all match.
 */
export interface OperationRequest<Kind extends string> {
  readonly input: string;
  readonly kind: Kind;
  /** No id means no replay: the attempt simply runs. */
  readonly operationId: string | undefined;
  readonly target: string;
}

/**
 * How one kind of operation crosses the ledger. The ledger keeps an `Outcome`
 * rather than the caller's own result type, so one ledger holds every kind.
 */
export interface OperationCodec<A, E, Outcome, Conflict> {
  /**
   * What a finished attempt leaves under its id. `undefined` keeps nothing,
   * so the id stays free and the caller can retry it. An interrupted or
   * defective attempt never reaches this and keeps nothing either.
   */
  readonly keep: (result: Result.Result<A, E>) => Outcome | undefined;
  /** How a kept outcome answers an identical request. */
  readonly replay: (
    outcome: Outcome,
    operationId: string
  ) => Effect.Effect<A, E | Conflict>;
}

export interface OperationLedger<Kind extends string, Outcome, Conflict> {
  /**
   * Run `attempt` at most once per kept operation id. An identical request
   * answers with the kept outcome and runs nothing, a different request under
   * a bound id is refused, and identical requests that arrive together wait
   * for the first so they all receive its outcome.
   */
  readonly run: <A, E, R>(
    request: OperationRequest<Kind>,
    attempt: Effect.Effect<A, E, R>,
    codec: OperationCodec<A, E, Outcome, Conflict>
  ) => Effect.Effect<A, E | Conflict, R>;
}

/**
 * One operation id. It is bound to its first request while any caller holds
 * it or once an outcome is kept; an id whose attempts all ended without one
 * is forgotten, so nothing pins a request that never took effect.
 */
interface Binding<Kind extends string, Outcome> {
  readonly gate: Semaphore.Semaphore;
  holders: number;
  kept: { readonly outcome: Outcome } | undefined;
  readonly request: OperationRequest<Kind>;
}

const sameRequest = <Kind extends string>(
  left: OperationRequest<Kind>,
  right: OperationRequest<Kind>
) =>
  left.kind === right.kind &&
  left.target === right.target &&
  left.input === right.input;

/** Run or replay under the id's gate, keeping what the codec says to keep. */
const settle = <Kind extends string, Outcome, Conflict, A, E, R>(
  binding: Binding<Kind, Outcome>,
  operationId: string,
  attempt: Effect.Effect<A, E, R>,
  codec: OperationCodec<A, E, Outcome, Conflict>
): Effect.Effect<A, E | Conflict, R> =>
  binding.gate.withPermit(
    Effect.suspend(() => {
      if (binding.kept !== undefined) {
        return codec.replay(binding.kept.outcome, operationId);
      }
      // Only the attempt is interruptible: once it settles, its outcome is
      // kept before anything can stop this fiber.
      return Effect.uninterruptibleMask((restore) =>
        Effect.result(restore(attempt)).pipe(
          Effect.flatMap((result) => {
            const outcome = codec.keep(result);
            if (outcome !== undefined) {
              binding.kept = { outcome };
            }
            return Effect.fromResult(result);
          })
        )
      );
    })
  );

/**
 * The process-local ledger behind operation-id replay. Kept outcomes live for
 * the ledger's lifetime; durable receipts that must survive a restart belong
 * to their own store.
 */
export const makeOperationLedger = <Kind extends string, Outcome, Conflict>(
  conflict: (
    operationId: string,
    bound: OperationRequest<Kind>,
    request: OperationRequest<Kind>
  ) => Conflict
): OperationLedger<Kind, Outcome, Conflict> => {
  const bindings = new Map<string, Binding<Kind, Outcome>>();

  const run = <A, E, R>(
    request: OperationRequest<Kind>,
    attempt: Effect.Effect<A, E, R>,
    codec: OperationCodec<A, E, Outcome, Conflict>
  ): Effect.Effect<A, E | Conflict, R> => {
    const { operationId } = request;
    if (operationId === undefined) {
      return attempt;
    }
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const bound = bindings.get(operationId);
        if (bound !== undefined) {
          if (!sameRequest(bound.request, request)) {
            return Result.fail(conflict(operationId, bound.request, request));
          }
          bound.holders += 1;
          return Result.succeed(bound);
        }
        const binding: Binding<Kind, Outcome> = {
          gate: Semaphore.makeUnsafe(1),
          holders: 1,
          kept: undefined,
          request,
        };
        bindings.set(operationId, binding);
        return Result.succeed(binding);
      }),
      (claimed) =>
        Result.isFailure(claimed)
          ? Effect.fail(claimed.failure)
          : settle(claimed.success, operationId, attempt, codec),
      (claimed) =>
        Effect.sync(() => {
          if (Result.isFailure(claimed)) {
            return;
          }
          const binding = claimed.success;
          binding.holders -= 1;
          if (binding.holders === 0 && binding.kept === undefined) {
            bindings.delete(operationId);
          }
        })
    );
  };

  return { run };
};
