import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  MAX_BINDING_PAYLOAD_BYTES,
  MAX_EVENTS_PER_SECOND,
  makeEventRateLimit,
  makeOrderedRecorderEventHandler,
  readRecorderPayload,
  refusalMessage,
} from "../../src/services/recorder-events.ts";
import type {
  RecorderCaptureEvent,
  RecorderSequences,
} from "../../src/services/recorder-events.ts";

const payload = (event: unknown, sequence: number, documentId = "doc-1") =>
  JSON.stringify({ documentId, event, sequence });

const click = {
  button: "left",
  target: [{ kind: "role", name: "Add to cart", role: "button" }],
  type: "click",
};

const read = (raw: unknown, sequences: RecorderSequences = new Map()) =>
  readRecorderPayload(raw, sequences);

const refusalOf = (raw: unknown): string => {
  const outcome = readRecorderPayload(raw, new Map());
  return outcome._tag === "refused" ? outcome.refusal._tag : "accepted";
};

it("accepts a recorder event that continues its document's sequence", () => {
  const sequences: RecorderSequences = new Map();
  expect(read(payload(click, 1), sequences)).toEqual({
    _tag: "accepted",
    event: click,
  });
  expect(read(payload(click, 2), sequences)._tag).toBe("accepted");
});

it("refuses a repeated, skipped, or overflowing sequence", () => {
  const sequences: RecorderSequences = new Map();
  expect(read(payload(click, 1), sequences)._tag).toBe("accepted");
  expect(read(payload(click, 1), sequences)).toEqual({
    _tag: "refused",
    refusal: { _tag: "sequence" },
  });
  expect(read(payload(click, 7), new Map())._tag).toBe("refused");
  expect(read(payload(click, 1_000_001), new Map())._tag).toBe("refused");
});

it("counts each document's sequence separately, so a reload is not a gap", () => {
  const sequences: RecorderSequences = new Map();
  expect(read(payload(click, 1, "doc-1"), sequences)._tag).toBe("accepted");
  expect(read(payload(click, 1, "doc-2"), sequences)._tag).toBe("accepted");
});

it("refuses malformed, non-string, and oversized recorder data", () => {
  expect(refusalOf("{")).toBe("malformed");
  expect(refusalOf({ event: click, sequence: 1 })).toBe("malformed");
  expect(refusalOf(payload({ type: "teleport" }, 1))).toBe("malformed");
  expect(
    refusalOf(
      payload(
        {
          ...click,
          target: [{ kind: "text", text: "x".repeat(4096) }],
        },
        1
      )
    )
  ).toBe("malformed");
  expect(refusalOf("x".repeat(MAX_BINDING_PAYLOAD_BYTES + 1))).toBe("oversize");
});

it("never accepts a test-id locator descriptor", () => {
  expect(
    read(payload({ ...click, target: [{ kind: "testId", testId: "cart" }] }, 1))
      ._tag
  ).toBe("refused");
});

it("names each refusal in the words the author reads", () => {
  expect(refusalMessage({ _tag: "malformed" })).toBe(
    "The page sent malformed recorder data."
  );
  expect(refusalMessage({ _tag: "oversize" })).toBe(
    "The page sent an oversized recorder event."
  );
  expect(refusalMessage({ _tag: "sequence" })).toBe(
    "The page recorder event sequence was interrupted."
  );
});

it("limits how many events a page may report per second", () => {
  let now = 0;
  const limit = makeEventRateLimit(() => now);
  for (let index = 0; index < MAX_EVENTS_PER_SECOND; index += 1) {
    expect(limit.exceeded()).toBe(false);
  }
  expect(limit.exceeded()).toBe(true);
  now = 1000;
  expect(limit.exceeded()).toBe(false);
});

const scrollEvent = (page: number): RecorderCaptureEvent => ({
  deltaY: 100,
  page,
  type: "scroll",
});

it.live("reduces captured events one at a time, in arrival order", () =>
  Effect.gen(function* reduceInOrder() {
    const seen: number[] = [];
    const handler = makeOrderedRecorderEventHandler(
      (event) =>
        Effect.gen(function* record() {
          // The first reduction is deliberately slow. A handler that did not
          // serialize would finish the second one first.
          if (event.page === 0) {
            yield* Effect.sleep("50 millis");
          }
          seen.push(event.page);
        }),
      () => Effect.void
    );
    handler.dispatch(scrollEvent(0));
    handler.dispatch(scrollEvent(1));
    yield* handler.close();
    expect(seen).toEqual([0, 1]);
  })
);

it.live("stops reducing once a captured event has failed", () =>
  Effect.gen(function* stopAfterFailure() {
    const seen: number[] = [];
    const failures: string[] = [];
    const handler = makeOrderedRecorderEventHandler(
      (event) =>
        Effect.sync(() => {
          seen.push(event.page);
        }),
      (message) =>
        Effect.sync(() => {
          failures.push(message);
        })
    );
    handler.dispatch({
      page: 0,
      reason: "An element on the page could not be addressed by any locator.",
      type: "unsupported",
    });
    handler.dispatch(scrollEvent(1));
    yield* handler.close();
    yield* Effect.sleep("10 millis");
    expect(seen).toEqual([]);
    expect(failures).toEqual([
      "An element on the page could not be addressed by any locator.",
    ]);
  })
);
