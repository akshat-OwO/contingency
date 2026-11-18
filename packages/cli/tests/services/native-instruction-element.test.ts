import { expect, it } from "vitest";

import { resolveInstructionElement } from "../../src/services/native-instruction-element.ts";

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
