import { expect, it } from "vitest";

import {
  appendInstruction,
  instructionElementBox,
  resolveInstructionElement,
} from "../../src/services/native-instruction-element.ts";

const done = (target: string, packageName: string) => ({
  bounds: { height: 44, width: 80, x: 280, y: 60 },
  covered: false,
  editable: false,
  name: "Done",
  packageName,
  role: "button",
  target,
});
const resolve = (latestApp: string) =>
  resolveInstructionElement({
    appId: "dev.fallback",
    element: { observationId: "before", target: "@e1" },
    latest: { id: "after", nodes: [done("@e9", latestApp)] },
    platform: "ios",
    retained: [{ id: "before", nodes: [done("@e1", "dev.original")] }],
    unobserved: 0,
  });

it("refuses a look-alike control after the foreground app changed", () => {
  // Another app's Done in the same place is not the element the user picked.
  expect(resolve("com.apple.Preferences")).toBeUndefined();
});

it("keeps a pick on the same app's screen and names that app", () => {
  expect(resolve("dev.original")).toMatchObject({
    context: ["dev.original"],
    name: "Done",
    observationId: "before",
  });
});

it("places an element in fractions of its screen, clipped to it", () => {
  const screen = { height: 2400, width: 1080 };
  expect(
    instructionElementBox({ height: 600, width: 540, x: 270, y: 600 }, screen)
  ).toEqual({ height: 0.25, left: 0.25, top: 0.25, width: 0.5 });
  // Part off the left edge: only the visible part is boxed.
  expect(
    instructionElementBox({ height: 480, width: 540, x: -270, y: 0 }, screen)
  ).toEqual({ height: 0.2, left: 0, top: 0, width: 0.25 });
  // Wholly off screen, without bounds, or on an unsized screen: no box.
  expect(
    instructionElementBox({ height: 10, width: 10, x: 2000, y: 0 }, screen)
  ).toBeNull();
  expect(instructionElementBox(undefined, screen)).toBeNull();
  expect(
    instructionElementBox(
      { height: 1, width: 1, x: 0, y: 0 },
      { height: 0, width: 0 }
    )
  ).toBeNull();
});

const comment = (index: number) => ({
  at: "2026-11-19T00:00:00.000Z",
  id: `comment-${index}`,
  target: null,
  text: `Comment ${index}`,
});

it("keeps only the latest comments a summary may carry, oldest first", () => {
  let listed = appendInstruction(undefined, comment(0));
  for (let index = 1; index < 205; index += 1) {
    listed = appendInstruction(listed, comment(index));
  }
  expect(listed).toHaveLength(200);
  expect(listed[0]?.id).toBe("comment-5");
  expect(listed.at(-1)?.id).toBe("comment-204");
});
