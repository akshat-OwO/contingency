import type { Cause } from "effect";
import { Context, Effect, Option, Random } from "effect";

/**
 * A Failure Reference names one failure whose cause the code does not fully
 * state: a defect, or a runtime or child-process failure. The agent and the
 * Workspace see the reference; the cause stays in this process, logged by its
 * shape in the Diagnostic Log and kept whole in memory ([ADR 0089](../../../../docs/adr/0089-failure-causes-stay-local-behind-a-failure-reference.md)).
 */
export type FailureReference = string;

/** Crockford base32: no I, L, O, or U, so a reference reads aloud cleanly. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 6;
/** How many causes a process keeps; the oldest goes first. */
export const FAILURE_REFERENCE_CAPACITY = 500;

export const isFailureReference = (value: string): boolean =>
  value.length === LENGTH &&
  [...value].every((character) => ALPHABET.includes(character));

export interface FailureReferenceStore {
  readonly keep: (
    reference: FailureReference,
    cause: Cause.Cause<unknown>
  ) => void;
  readonly lookup: (
    reference: FailureReference
  ) => Option.Option<Cause.Cause<unknown>>;
}

export const makeFailureReferenceStore = (
  capacity = FAILURE_REFERENCE_CAPACITY
): FailureReferenceStore => {
  // A Map keeps insertion order, so its first key is the oldest cause.
  const causes = new Map<FailureReference, Cause.Cause<unknown>>();
  return {
    keep: (reference, cause) => {
      causes.set(reference, cause);
      while (causes.size > capacity) {
        const [oldest] = causes.keys();
        if (oldest === undefined) {
          return;
        }
        causes.delete(oldest);
      }
    },
    lookup: (reference) => Option.fromUndefinedOr(causes.get(reference)),
  };
};

/** The process's causes. A test provides its own store. */
export const FailureReferences = Context.Reference<FailureReferenceStore>(
  "contingency/FailureReferences",
  { defaultValue: () => makeFailureReferenceStore() }
);

const newReference = Effect.gen(function* newReference() {
  let reference = "";
  for (let index = 0; index < LENGTH; index += 1) {
    reference +=
      ALPHABET[
        yield* Random.nextIntBetween(0, ALPHABET.length, {
          halfOpen: true,
        })
      ];
  }
  return reference;
});

/**
 * Gives a failure a reference: one Error record in the Diagnostic Log, with
 * the cause by its shape, and the whole cause kept for `lookup`.
 */
export const recordFailure = (
  cause: Cause.Cause<unknown>,
  code: string
): Effect.Effect<FailureReference> =>
  Effect.gen(function* recordCause() {
    const store = yield* FailureReferences;
    const reference = yield* newReference;
    store.keep(reference, cause);
    yield* Effect.logError("Failure recorded", cause).pipe(
      Effect.annotateLogs({ code, failureReference: reference })
    );
    return reference;
  });

/** The cause recorded for a reference, if this process still holds it. */
export const lookupFailure = (
  reference: FailureReference
): Effect.Effect<Option.Option<Cause.Cause<unknown>>> =>
  Effect.gen(function* readCause() {
    return (yield* FailureReferences).lookup(reference);
  });
