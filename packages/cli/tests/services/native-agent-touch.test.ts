import { AgentSessionId, agentPointerTravelMs } from "@contingency/protocol";
import type { NativeAgentTouch } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  makeNativeAgentTouches,
  nativeTouchTravelMs,
  TOUCH_LEAD_MS,
} from "../../src/services/native-agent-touch.ts";

const session = AgentSessionId.make("agent-session-touch");
const screen = { height: 2400, width: 1080 };

it.effect(
  "publishes the agent's touch in device pixels before the gesture",
  () =>
    Effect.gen(function* firstTouch() {
      const touches = yield* makeNativeAgentTouches;
      const received = yield* touches
        .stream(session)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
      // `it.effect` provides TestClock, so the touch's wait never elapses on
      // its own: the gesture is held until the clock is moved past it.
      const touching = yield* touches
        .touch(session, { action: "tap", x: 540, y: 1200 }, screen)
        .pipe(Effect.forkChild);
      const [touch] = yield* Fiber.join(received);
      expect(touch).toEqual({
        action: "tap",
        durationMs: 0,
        screen,
        timestamp: 0,
        type: "agent_touch",
        x: 540,
        y: 1200,
      } satisfies NativeAgentTouch);
      yield* TestClock.adjust(TOUCH_LEAD_MS - 1);
      expect(touching.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1);
      yield* Fiber.join(touching);
    }).pipe(Effect.scoped)
);

it.effect("travels from where the last touch rested and waits for it", () =>
  Effect.gen(function* secondTouch() {
    const touches = yield* makeNativeAgentTouches;
    yield* touches
      .touch(session, { action: "tap", x: 0, y: 0 }, screen)
      .pipe(Effect.forkChild);
    yield* TestClock.adjust(TOUCH_LEAD_MS);
    const swipe = yield* touches
      .touch(
        session,
        { action: "swipe", end: { x: 540, y: 400 }, x: 540, y: 1800 },
        screen
      )
      .pipe(Effect.forkChild);
    // A late subscriber hears the latest touch: the tap until the swipe
    // is published, then the swipe.
    const [latest] = yield* touches.stream(session).pipe(
      Stream.filter((touch) => touch.action === "swipe"),
      Stream.take(1),
      Stream.runCollect
    );
    const durationMs = nativeTouchTravelMs(
      { x: 0, y: 0 },
      { x: 540, y: 1800 },
      screen.width
    );
    expect(durationMs).toBeGreaterThan(0);
    expect(latest).toMatchObject({
      action: "swipe",
      durationMs,
      end: { x: 540, y: 400 },
    });
    yield* TestClock.adjust(durationMs + TOUCH_LEAD_MS);
    yield* Fiber.join(swipe);
    // The next touch starts from where the swipe ended.
    expect(
      nativeTouchTravelMs({ x: 540, y: 400 }, { x: 540, y: 400 }, screen.width)
    ).toBe(0);
  }).pipe(Effect.scoped)
);

it("times a device reach as the same reach on a 400 pixel wide Page", () => {
  expect(nativeTouchTravelMs({ x: 0, y: 0 }, { x: 1080, y: 0 }, 1080)).toBe(
    agentPointerTravelMs(400)
  );
  expect(nativeTouchTravelMs(undefined, { x: 10, y: 10 }, 1080)).toBe(0);
});

it.effect("ends a released session's stream and ignores its touches", () =>
  Effect.gen(function* releaseSession() {
    const touches = yield* makeNativeAgentTouches;
    // Whether it subscribes before or after the release, the stream ends.
    const listening = yield* touches
      .stream(session)
      .pipe(Stream.runCollect, Effect.forkChild);
    yield* touches.release(session);
    expect(yield* Fiber.join(listening)).toEqual([]);
    // A touch after close neither publishes nor waits on the clock.
    yield* touches.touch(session, { action: "tap", x: 1, y: 1 }, screen);
    expect(yield* touches.stream(session).pipe(Stream.runCollect)).toEqual([]);
  }).pipe(Effect.scoped)
);
