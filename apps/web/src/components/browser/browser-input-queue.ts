import type { BrowserInput } from "@contingency/protocol";
import { Effect } from "effect";

/** The most inputs one request carries; the protocol refuses more. */
const INPUT_BATCH_LIMIT = 256;

const isPointerMove = (input: BrowserInput): boolean =>
  input.type === "input_mouse" && input.eventType === "mouseMoved";

const sameDirection = (previous = 0, next = 0) =>
  previous === 0 || next === 0 || Math.sign(previous) === Math.sign(next);

/** Keep changes of direction and scroll targets as ordered input boundaries. */
const combineWheelInput = (
  previous: BrowserInput,
  next: BrowserInput
): BrowserInput | undefined => {
  if (
    previous.type !== "input_mouse" ||
    next.type !== "input_mouse" ||
    previous.eventType !== "mouseWheel" ||
    next.eventType !== "mouseWheel" ||
    previous.x !== next.x ||
    previous.y !== next.y ||
    previous.modifiers !== next.modifiers ||
    previous.button !== next.button ||
    !sameDirection(previous.deltaX, next.deltaX) ||
    !sameDirection(previous.deltaY, next.deltaY)
  ) {
    return;
  }
  return {
    ...next,
    deltaX: (previous.deltaX ?? 0) + (next.deltaX ?? 0),
    deltaY: (previous.deltaY ?? 0) + (next.deltaY ?? 0),
  };
};

/**
 * Sends the user's inputs in the order they made them, one request at a time.
 * What queues while a request is in flight goes out together as the next
 * request, so a key waits for at most the one request ahead of it instead of
 * one round trip for every key typed before it (#298). Consecutive pointer
 * moves collapse into the latest. Compatible wheel deltas add together while
 * a request is pending: dispatch may wait for a compositor frame, so sending
 * each trackpad sample separately accumulates seconds of delayed scrolling.
 */
export const makeBrowserInputQueue = <SessionId extends string>(
  send: (
    sessionId: SessionId,
    inputs: readonly [BrowserInput, ...BrowserInput[]]
  ) => Effect.Effect<unknown, unknown>
) => {
  const queued: {
    readonly input: BrowserInput;
    readonly sessionId: SessionId;
  }[] = [];
  let sending = false;
  const drain = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      const [first] = queued;
      if (first === undefined) {
        sending = false;
        return Effect.void;
      }
      const otherSession = queued.findIndex(
        (entry) => entry.sessionId !== first.sessionId
      );
      const [, ...rest] = queued.splice(
        0,
        Math.min(
          otherSession === -1 ? queued.length : otherSession,
          INPUT_BATCH_LIMIT
        )
      );
      return send(first.sessionId, [
        first.input,
        ...rest.map((entry) => entry.input),
      ]).pipe(Effect.ignoreCause, Effect.andThen(drain));
    });
  return (sessionId: SessionId, input: BrowserInput): void => {
    const last = queued.at(-1);
    const wheel =
      last?.sessionId === sessionId
        ? combineWheelInput(last.input, input)
        : undefined;
    if (wheel !== undefined) {
      queued[queued.length - 1] = { input: wheel, sessionId };
      return;
    }
    if (
      last !== undefined &&
      last.sessionId === sessionId &&
      isPointerMove(last.input) &&
      isPointerMove(input)
    ) {
      queued[queued.length - 1] = { input, sessionId };
    } else {
      queued.push({ input, sessionId });
    }
    if (sending) {
      return;
    }
    sending = true;
    Effect.runFork(drain());
  };
};
