import { NativeAgentTouch } from "@contingency/protocol";
import { Result, Schema } from "effect";
import { expect, test } from "vitest";

const decode = Schema.decodeUnknownResult(NativeAgentTouch);
const base = {
  durationMs: 220,
  screen: { height: 2400, width: 1080 },
  timestamp: 1_763_456_000_000,
  type: "agent_touch",
  x: 540,
  y: 1200,
};

test("a tap and a long press touch one point in device pixels", () => {
  expect(Result.isSuccess(decode({ ...base, action: "tap" }))).toBe(true);
  expect(Result.isSuccess(decode({ ...base, action: "press" }))).toBe(true);
});

test("a swipe names where it ends", () => {
  expect(
    Result.isSuccess(
      decode({ ...base, action: "swipe", end: { x: 540, y: 400 } })
    )
  ).toBe(true);
  expect(Result.isFailure(decode({ ...base, action: "swipe" }))).toBe(true);
});

test("refuses a touch the stage cannot place", () => {
  expect(Result.isFailure(decode({ ...base, action: "click" }))).toBe(true);
  expect(Result.isFailure(decode({ ...base, action: "tap", x: -1 }))).toBe(
    true
  );
  expect(
    Result.isFailure(decode({ ...base, action: "tap", durationMs: -5 }))
  ).toBe(true);
  expect(
    Result.isFailure(
      decode({ ...base, action: "tap", screen: { height: 0, width: 1080 } })
    )
  ).toBe(true);
  expect(
    Result.isFailure(decode({ ...base, action: "tap", type: "agent_pointer" }))
  ).toBe(true);
});
