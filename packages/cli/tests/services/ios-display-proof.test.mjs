import { expect, it, test } from "vitest";

import {
  awaitProofStage,
  proofCaptureStage,
} from "../../../../.cursor/skills/verify-contingency/bin/ios-display-proof-events.mjs";

it("returns on the event that exposes an in-flight stage", async () => {
  let matched = false;
  let released = false;
  const changes = (async function* journal() {
    try {
      matched = true;
      yield "input started";
      throw new Error("Waited past input start for a second event");
    } finally {
      released = true;
    }
  })();
  expect(
    await awaitProofStage(changes, () =>
      Promise.resolve(matched ? "in-flight" : null)
    )
  ).toBe("in-flight");
  expect(released).toBe(true);
});

it("does not await a journal event when the stage already exists", async () => {
  const changes = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () =>
      Promise.reject(
        new Error("Already matched before the first journal event")
      ),
    return: () => Promise.resolve({ done: true }),
  };
  expect(
    await awaitProofStage(changes, () => Promise.resolve("settling"))
  ).toBe("settling");
});

test("waits for pixels rather than session-list metadata during settling", () => {
  const fill = { end: "2026-10-29T00:00:01Z" };
  const metadata = {
    command: "session_list",
    end: null,
    start: "2026-10-29T00:00:02Z",
  };
  const pixels = {
    command: "screenshot",
    end: null,
    start: "2026-10-29T00:00:03Z",
  };
  expect(proofCaptureStage([metadata], fill)).toBeUndefined();
  expect(proofCaptureStage([metadata, pixels], fill)).toBe(pixels);
});
