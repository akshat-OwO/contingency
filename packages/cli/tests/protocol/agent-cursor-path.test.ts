import { cursorPointAt, planCursorPath } from "@contingency/protocol";
import { describe, expect, it } from "vitest";

/** A repeatable stand-in for `Math.random`. */
const seeded = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
};

describe("planCursorPath", () => {
  const from = { x: 40, y: 60 };
  const to = { x: 640, y: 420 };

  it("starts at the origin and lands exactly on the target", () => {
    const path = planCursorPath(from, to, 400, seeded(1));
    expect(cursorPointAt(path, 0)).toEqual(from);
    expect(cursorPointAt(path, path.durationMs)).toEqual(to);
    expect(cursorPointAt(path, path.durationMs + 500)).toEqual(to);
  });

  it("bows away from the straight line between the points", () => {
    const path = planCursorPath(from, to, 400, seeded(2));
    const middle = cursorPointAt(path, path.durationMs / 2);
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const offLine =
      Math.abs(
        (to.x - from.x) * (from.y - middle.y) -
          (from.x - middle.x) * (to.y - from.y)
      ) / length;
    expect(offLine).toBeGreaterThan(1);
  });

  it("keeps the bow shallow", () => {
    const widest = planCursorPath(from, to, 400, () => 0.999999);
    expect(Math.abs(widest.bend)).toBeLessThanOrEqual(40);
    const short = planCursorPath(from, { x: 140, y: 60 }, 400, () => 0);
    expect(Math.abs(short.bend)).toBeLessThanOrEqual(10);
  });

  it("moves steadily towards the target without doubling back", () => {
    const path = planCursorPath(from, to, 400, seeded(7));
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const progress = (elapsed: number) => {
      const point = cursorPointAt(path, elapsed);
      return (
        ((point.x - from.x) * (to.x - from.x) +
          (point.y - from.y) * (to.y - from.y)) /
        length
      );
    };
    for (let elapsed = 0; elapsed < 400; elapsed += 16) {
      expect(progress(elapsed + 16)).toBeGreaterThanOrEqual(progress(elapsed));
    }
  });

  it("draws a different stroke each time", () => {
    const first = planCursorPath(from, to, 400, seeded(3));
    const second = planCursorPath(from, to, 400, seeded(4));
    expect(first.bend).not.toBe(second.bend);
  });

  it("takes the duration the server waits for", () => {
    expect(planCursorPath(from, to, 333, seeded(6)).durationMs).toBe(333);
  });

  it("does not move for a point it is already on", () => {
    const path = planCursorPath(from, from, 400, seeded(5));
    expect(Math.abs(path.bend)).toBe(0);
    expect(cursorPointAt(path, 200)).toEqual(from);
  });
});
