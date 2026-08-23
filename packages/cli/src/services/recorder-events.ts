import { makeBrowserRpcError } from "@contingency/protocol";
import type { BrowserRpcErrorType } from "@contingency/protocol";
import { Deferred, Effect, Schema } from "effect";

/**
 * What a page may say, and how much of it.
 *
 * Everything the recorder script emits crosses an exposed binding a page could
 * call itself, so it is untrusted by construction: bounded in size, validated
 * against these schemas, and refused rather than repaired ([ADR
 * 0012](../../../../docs/adr/0012-playwright-is-the-in-process-browser-runtime.md)).
 */
export const MAX_BINDING_PAYLOAD_BYTES = 64 * 1024;
export const MAX_EVENTS_PER_SECOND = 200;
export const MAX_SEQUENCE = 1_000_000;
const MAX_LOCATOR_LENGTH = 2048;
const MAX_LOCATORS = 8;
const MAX_VALUE_LENGTH = 16 * 1024;
const MAX_OPTION_VALUES = 32;
const MAX_KEY_LENGTH = 64;
const MAX_REASON_LENGTH = 512;
const MAX_URL_LENGTH = 2048;

const bounded = (limit: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(limit));
const boundedText = bounded(MAX_LOCATOR_LENGTH);

/**
 * The ladder a page may describe its element with, in the order a Run tries
 * it. There is no test-id member here and none in the Flow schema, so no
 * amount of page cooperation can produce one.
 */
const RecordedLocator = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("role"),
    name: boundedText,
    role: boundedText,
  }),
  Schema.Struct({ kind: Schema.Literal("label"), label: boundedText }),
  Schema.Struct({
    kind: Schema.Literal("placeholder"),
    placeholder: boundedText,
  }),
  Schema.Struct({ kind: Schema.Literal("text"), text: boundedText }),
  Schema.Struct({ kind: Schema.Literal("css"), selector: boundedText }),
  Schema.Struct({ expression: boundedText, kind: Schema.Literal("xpath") }),
]);

const RecordedTarget = Schema.Array(RecordedLocator).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_LOCATORS)
);

const ClickCapture = Schema.Struct({
  button: Schema.Literals(["left", "middle", "right"]),
  target: RecordedTarget,
  type: Schema.Literal("click"),
});

const ChangeCapture = Schema.Struct({
  target: RecordedTarget,
  type: Schema.Literal("change"),
  value: Schema.String.check(Schema.isMaxLength(MAX_VALUE_LENGTH)),
  variable: Schema.optional(bounded(MAX_KEY_LENGTH)),
});

const SelectOptionCapture = Schema.Struct({
  target: RecordedTarget,
  type: Schema.Literal("selectOption"),
  values: Schema.Array(bounded(MAX_VALUE_LENGTH)).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_OPTION_VALUES)
  ),
});

const PressCapture = Schema.Struct({
  key: bounded(MAX_KEY_LENGTH),
  target: Schema.optional(RecordedTarget),
  type: Schema.Literal("press"),
});

const ScrollCapture = Schema.Struct({
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
  type: Schema.Literal("scroll"),
});

/** What the page reports, before the CLI says which Page it happened on. */
export const RecorderPayload = Schema.Struct({
  /**
   * The document the counter belongs to. A reload starts a new document with
   * its own sequence, so a fresh counter is recognised rather than read as a
   * dropped event.
   */
  documentId: bounded(128),
  event: Schema.Union([
    ClickCapture,
    ChangeCapture,
    SelectOptionCapture,
    PressCapture,
    ScrollCapture,
    Schema.Struct({ type: Schema.Literal("beforeUnload") }),
    Schema.Struct({
      reason: bounded(MAX_REASON_LENGTH),
      type: Schema.Literal("unsupported"),
    }),
  ]),
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type RecorderPayload = typeof RecorderPayload.Type;

/** An action the page reported, as a Recording reduces it. */
export type CapturedAction = RecorderPayload["event"];

const NavigationCapture = Schema.Struct({
  causedByAction: Schema.optional(Schema.Boolean),
  title: Schema.optional(
    Schema.String.check(Schema.isMaxLength(MAX_URL_LENGTH))
  ),
  type: Schema.Literal("navigation"),
  url: bounded(MAX_URL_LENGTH),
});

/**
 * Everything a Recording reduces: what a page reported, plus what the browser
 * runtime observed about it. `page` is the Page's index in the order Pages
 * opened — the identity a Step names ([ADR
 * 0019](../../../../docs/adr/0019-recording-follows-pages.md)).
 */
export type RecorderCaptureEvent = { readonly page: number } & (
  | CapturedAction
  | typeof NavigationCapture.Type
);

export const recorderError = (message: string): BrowserRpcErrorType =>
  makeBrowserRpcError("recording_unavailable", message);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const decodeNavigationEvent = (
  value: unknown
): typeof NavigationCapture.Type | undefined => {
  const candidate = isRecord(value) ? { ...value, type: "navigation" } : value;
  const decoded = Schema.decodeUnknownResult(NavigationCapture)(candidate);
  return decoded._tag === "Success" && decoded.success.url.startsWith("http")
    ? decoded.success
    : undefined;
};

/** Why a payload was refused, in the words the author will read. */
export type PayloadRefusal =
  | { readonly _tag: "malformed" }
  | { readonly _tag: "oversize" }
  | { readonly _tag: "sequence" };

export type PayloadOutcome =
  | { readonly _tag: "accepted"; readonly event: CapturedAction }
  | { readonly _tag: "refused"; readonly refusal: PayloadRefusal };

export const refusalMessage = (refusal: PayloadRefusal): string => {
  switch (refusal._tag) {
    case "malformed": {
      return "The page sent malformed recorder data.";
    }
    case "oversize": {
      return "The page sent an oversized recorder event.";
    }
    default: {
      return "The page recorder event sequence was interrupted.";
    }
  }
};

/**
 * The per-document sequence a Recording expects next. Held by the caller so
 * this stays a pure decision: a page cannot make the recorder forget what it
 * has already accepted.
 */
export type RecorderSequences = Map<string, number>;

/**
 * Read one payload from a page. A payload is accepted only if it is within
 * bounds, decodes, and continues its document's sequence exactly — a gap, a
 * repeat, or an overflow is a lost-integrity failure, not a dropped event.
 */
export const readRecorderPayload = (
  raw: unknown,
  sequences: RecorderSequences
): PayloadOutcome => {
  if (typeof raw !== "string") {
    return { _tag: "refused", refusal: { _tag: "malformed" } };
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BINDING_PAYLOAD_BYTES) {
    return { _tag: "refused", refusal: { _tag: "oversize" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { _tag: "refused", refusal: { _tag: "malformed" } };
  }
  const decoded = Schema.decodeUnknownResult(RecorderPayload)(parsed);
  if (decoded._tag === "Failure") {
    return { _tag: "refused", refusal: { _tag: "malformed" } };
  }
  const { documentId, event, sequence } = decoded.success;
  const expected = sequences.get(documentId) ?? 1;
  if (sequence !== expected || sequence > MAX_SEQUENCE) {
    return { _tag: "refused", refusal: { _tag: "sequence" } };
  }
  sequences.set(documentId, expected + 1);
  return { _tag: "accepted", event };
};

/**
 * How many events a page may report before it is reporting a defect rather
 * than an author's work. Held per Recording, checked per event.
 */
export const makeEventRateLimit = (
  now: () => number = Date.now
): { readonly exceeded: () => boolean } => {
  let windowStart = now();
  let count = 0;
  return {
    exceeded: () => {
      const at = now();
      if (at - windowStart >= 1000) {
        windowStart = at;
        count = 0;
      }
      count += 1;
      return count > MAX_EVENTS_PER_SECOND;
    },
  };
};

export interface OrderedRecorderEventHandler {
  readonly close: () => Effect.Effect<void>;
  readonly dispatch: (event: RecorderCaptureEvent) => void;
}

/**
 * Reduce captured events one at a time, in the order they arrived.
 *
 * Pages report concurrently — a popup and its opener are separate connections
 * — but a Recording is an ordered list of Steps, so the reduction is
 * serialized here rather than in every caller. The first failure stops the
 * rest: a Recording that lost integrity must not keep appending Steps behind
 * the failure it already reported.
 */
export const makeOrderedRecorderEventHandler = (
  onEvent: (
    event: RecorderCaptureEvent
  ) => Effect.Effect<void, BrowserRpcErrorType>,
  onFailure: (message: string) => Effect.Effect<void>
): OrderedRecorderEventHandler => {
  let tail = Deferred.makeUnsafe<true>();
  let accepting = true;
  let failed = false;
  Deferred.doneUnsafe(tail, Effect.succeed(true));

  return {
    close: () => {
      accepting = false;
      return Deferred.await(tail).pipe(Effect.asVoid);
    },
    dispatch: (event) => {
      if (!accepting) {
        return;
      }
      const previous = tail;
      const completed = Deferred.makeUnsafe<true>();
      tail = completed;
      Effect.runFork(
        Deferred.await(previous).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (failed) {
                return Effect.void;
              }
              return event.type === "unsupported"
                ? Effect.fail(recorderError(event.reason))
                : onEvent(event);
            })
          ),
          // Effect error recovery is callback-based by design.
          // oxlint-disable-next-line promise/prefer-await-to-callbacks, promise/prefer-await-to-then
          Effect.catch((error) =>
            Effect.sync(() => {
              failed = true;
              Effect.runFork(onFailure(error.message));
            })
          ),
          Effect.ensuring(Deferred.succeed(completed, true))
        )
      );
    },
  };
};
