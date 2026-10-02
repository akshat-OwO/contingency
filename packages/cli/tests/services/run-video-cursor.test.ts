import { AGENT_POINTER_ENTRY_OFFSET } from "@contingency/protocol";
import { describe, expect, it } from "vitest";

import {
  cursorAt,
  planCursorStrokes,
} from "../../src/services/run-video-cursor.ts";

const strokes = planCursorStrokes([
  { action: "click", atMs: 1000, durationMs: 300, x: 200, y: 100 },
  { action: "move", atMs: 4000, durationMs: 200, x: 400, y: 300 },
]);

describe("cursorAt", () => {
  it("draws no cursor before the agent first points", () => {
    expect(cursorAt(strokes, [], 999)).toBeUndefined();
  });

  it("enters from the Workspace's offset and lands on the target", () => {
    const entering = cursorAt(strokes, [], 1000);
    expect(entering?.x).toBeCloseTo(200 + AGENT_POINTER_ENTRY_OFFSET.x);
    expect(entering?.y).toBeCloseTo(100 + AGENT_POINTER_ENTRY_OFFSET.y);
    expect(cursorAt(strokes, [], 1300)).toMatchObject({ x: 200, y: 100 });
  });

  it("presses on a click: the arrow dips and the ring opens", () => {
    const pressed = cursorAt(strokes, [], 1400);
    expect(pressed?.glyphScale).toBeLessThan(1);
    expect(pressed?.ringOpacity).toBeGreaterThan(0);
    expect(cursorAt(strokes, [], 1900)?.ringOpacity).toBe(0);
  });

  it("dims once it has rested, and brightens on the next stroke", () => {
    expect(cursorAt(strokes, [], 3000)?.opacity).toBeCloseTo(0.4);
    const next = cursorAt(strokes, [], 4300);
    expect(next?.opacity).toBe(1);
    expect(next).toMatchObject({ x: 400, y: 300 });
  });

  it("hides while a person holds the browser", () => {
    const takeovers = [{ fromMs: 2000, toMs: 3500 }];
    expect(cursorAt(strokes, takeovers, 2500)).toBeUndefined();
    expect(cursorAt(strokes, takeovers, 3800)?.opacity).toBeGreaterThan(0);
  });

  it("starts an interrupting stroke from where the last one had reached", () => {
    const interrupted = planCursorStrokes([
      { action: "move", atMs: 0, durationMs: 400, x: 0, y: 0 },
      { action: "move", atMs: 500, durationMs: 400, x: 1000, y: 0 },
      { action: "move", atMs: 600, durationMs: 400, x: 1000, y: 1000 },
    ]);
    const start = cursorAt(interrupted, [], 600);
    expect(start?.x).toBeGreaterThan(0);
    expect(start?.x).toBeLessThan(1000);
  });

  it("draws the same arc on every render", () => {
    const again = planCursorStrokes([
      { action: "click", atMs: 1000, durationMs: 300, x: 200, y: 100 },
    ]);
    expect(cursorAt(again, [], 1150)).toEqual(cursorAt(strokes, [], 1150));
  });
});
