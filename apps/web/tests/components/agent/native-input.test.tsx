import type { NativeInput } from "@contingency/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Deferred, Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";

import {
  makeNativeInputHandlers,
  makeNativeInputQueue,
} from "@/components/agent/native-input";

afterEach(cleanup);

const touch = (action: "down" | "move" | "up", y: number): NativeInput => ({
  _tag: "touch",
  action,
  at: 0,
  x: 0.5,
  y,
});
const describeInput = (input: NativeInput) => {
  if (input._tag === "key") {
    return `key ${input.action} ${input.key}`;
  }
  if (input._tag === "scroll") {
    return `scroll ${input.x} ${input.y} ${input.deltaY}`;
  }
  return `touch ${input.action} ${input.x} ${input.y}`;
};

test("sends input in order, batching what queues behind a request", async () => {
  const sent: NativeInput[][] = [];
  const first = Effect.runSync(Deferred.make<boolean>());
  const delivered = Effect.runSync(Deferred.make<boolean>());
  const enqueue = makeNativeInputQueue((inputs) =>
    Effect.gen(function* send() {
      sent.push([...inputs]);
      yield* sent.length === 1
        ? Deferred.await(first)
        : Deferred.succeed(delivered, true);
    })
  );
  enqueue(touch("down", 0.1));
  // While the first request is in flight, moves collapse to the latest.
  enqueue(touch("move", 0.2));
  enqueue(touch("move", 0.3));
  enqueue(touch("up", 0.3));
  Effect.runSync(Deferred.succeed(first, true));
  await Effect.runPromise(Deferred.await(delivered));
  expect(sent).toEqual([
    [touch("down", 0.1)],
    [touch("move", 0.3), touch("up", 0.3)],
  ]);
});

test("a refused request reports its error and drops what queued behind it", async () => {
  const sent: NativeInput[][] = [];
  const refused = Effect.runSync(Deferred.make<unknown>());
  const failing = Effect.runSync(Deferred.make<boolean>());
  const refusal = new Error("Nothing was sent.");
  const enqueue = makeNativeInputQueue(
    (inputs) =>
      Effect.gen(function* send() {
        sent.push([...inputs]);
        yield* Deferred.await(failing);
        return yield* Effect.fail(refusal);
      }),
    (cause) => Effect.runSync(Deferred.succeed(refused, cause))
  );
  enqueue(touch("down", 0.1));
  enqueue(touch("up", 0.1));
  Effect.runSync(Deferred.succeed(failing, true));
  expect(await Effect.runPromise(Deferred.await(refused))).toBe(refusal);
  expect(sent).toEqual([[touch("down", 0.1)]]);
});

test("forwards one finger, the wheel, and keys as fractions of the display", () => {
  const inputs: NativeInput[] = [];
  const handlers = makeNativeInputHandlers(
    (input) => inputs.push(input),
    () => true
  );
  render(
    <div aria-label="display" role="application" tabIndex={0} {...handlers} />
  );
  const display = screen.getByRole("application", { name: "display" });
  vi.spyOn(display, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ height: 200, width: 100, x: 10, y: 20 })
  );
  fireEvent.pointerDown(display, {
    button: 0,
    clientX: 60,
    clientY: 70,
    isPrimary: true,
    pointerId: 1,
  });
  fireEvent.pointerMove(display, { clientX: 60, clientY: 170, pointerId: 1 });
  fireEvent.pointerUp(display, { clientX: 60, clientY: 170, pointerId: 1 });
  fireEvent.wheel(display, {
    clientX: 35,
    clientY: 220,
    deltaMode: 1,
    deltaY: 3,
  });
  fireEvent.keyDown(display, { code: "KeyA", key: "a" });
  fireEvent.keyUp(display, { code: "KeyA", key: "a" });
  expect(inputs.map(describeInput)).toEqual([
    "touch down 0.5 0.25",
    "touch move 0.5 0.75",
    "touch up 0.5 0.75",
    "scroll 0.25 1 120",
    "key down a",
    "key up a",
  ]);
});

test("sends nothing while the user cannot act", () => {
  const inputs: NativeInput[] = [];
  const handlers = makeNativeInputHandlers(
    (input) => inputs.push(input),
    () => false
  );
  render(
    <div aria-label="display" role="application" tabIndex={0} {...handlers} />
  );
  const display = screen.getByRole("application", { name: "display" });
  fireEvent.pointerDown(display, { button: 0, isPrimary: true, pointerId: 1 });
  fireEvent.keyDown(display, { code: "KeyA", key: "a" });
  expect(inputs).toEqual([]);
});
