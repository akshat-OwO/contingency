import { setImmediate } from "node:timers/promises";

import type { BrowserInput } from "@contingency/protocol";
import { Deferred, Effect } from "effect";
import { expect, test } from "vitest";

import { makeBrowserInputQueue } from "@/components/browser/browser-input";

const keyDown = (key: string): BrowserInput => ({
  eventType: "keyDown",
  key,
  text: key,
  type: "input_keyboard",
});

const move = (x: number): BrowserInput => ({
  eventType: "mouseMoved",
  type: "input_mouse",
  x,
  y: 0,
});

/** A server that answers each request only when the test releases it. */
const heldRequests = () => {
  const sent: {
    readonly inputs: readonly BrowserInput[];
    readonly sessionId: string;
  }[] = [];
  const pending: Deferred.Deferred<boolean>[] = [];
  const enqueue = makeBrowserInputQueue((sessionId: string, inputs) =>
    Effect.gen(function* holdRequest() {
      sent.push({ inputs, sessionId });
      const answer = Deferred.makeUnsafe<boolean>();
      pending.push(answer);
      yield* Deferred.await(answer);
    })
  );
  const answerNext = async () => {
    const answer = pending.shift();
    if (answer !== undefined) {
      Deferred.doneUnsafe(answer, Effect.succeed(true));
    }
    await setImmediate();
  };
  return { answerNext, enqueue, sent };
};

test("sends keys that queue behind a request as one ordered batch", async () => {
  const { answerNext, enqueue, sent } = heldRequests();

  enqueue("session-1", keyDown("a"));
  await setImmediate();
  enqueue("session-1", keyDown("b"));
  enqueue("session-1", keyDown("c"));
  enqueue("session-1", keyDown("d"));
  await setImmediate();

  // Only one request is ever in flight, so nothing overtakes "a".
  expect(sent).toHaveLength(1);
  await answerNext();
  expect(sent.map(({ inputs }) => inputs.map((input) => input.key))).toEqual([
    ["a"],
    ["b", "c", "d"],
  ]);
  await answerNext();
  enqueue("session-1", keyDown("e"));
  await setImmediate();
  expect(sent.at(-1)?.inputs.map((input) => input.key)).toEqual(["e"]);
});

test("collapses a pointer sweep into where it ended, keeping keys around it", async () => {
  const { answerNext, enqueue, sent } = heldRequests();

  enqueue("session-1", keyDown("a"));
  await setImmediate();
  enqueue("session-1", move(1));
  enqueue("session-1", move(2));
  enqueue("session-1", keyDown("b"));
  enqueue("session-1", move(3));
  enqueue("session-1", move(4));
  await answerNext();

  expect(sent[1]?.inputs).toEqual([move(2), keyDown("b"), move(4)]);
});

test("never mixes sessions in one request", async () => {
  const { answerNext, enqueue, sent } = heldRequests();

  enqueue("session-1", keyDown("a"));
  await setImmediate();
  enqueue("session-1", keyDown("b"));
  enqueue("session-2", keyDown("c"));
  await answerNext();
  await answerNext();

  expect(
    sent.map(({ sessionId, inputs }) => [sessionId, inputs.length])
  ).toEqual([
    ["session-1", 1],
    ["session-1", 1],
    ["session-2", 1],
  ]);
});

test("keeps sending after a request fails", async () => {
  const sent: string[] = [];
  const enqueue = makeBrowserInputQueue((_sessionId: string, inputs) => {
    sent.push(...inputs.map((input) => input.key ?? ""));
    return Effect.fail("refused");
  });

  enqueue("session-1", keyDown("a"));
  await setImmediate();
  enqueue("session-1", keyDown("b"));
  await setImmediate();

  expect(sent).toEqual(["a", "b"]);
});
