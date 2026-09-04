import type { AgentRunStep } from "@contingency/protocol";
import { expect, test } from "vitest";

import { coverageOf } from "../../src/services/agent-session.ts";

const step = (
  index: number,
  execution: AgentRunStep["execution"]
): AgentRunStep => ({
  assessment: null,
  attempts: 0,
  confirmation: false,
  description: `Step ${index + 1}.`,
  endedAt: null,
  execution,
  index,
  name: `Step ${index + 1}`,
  startedAt: null,
});

test("coverage is complete only when every Agent Step was assessed", () => {
  expect(
    coverageOf([step(0, "assessed"), step(1, "assessed"), step(2, "assessed")])
  ).toEqual({ complete: true, executed: 3, total: 3, unexecuted: 0 });
});

test("a timed-out final Step counts as executed without completing coverage", () => {
  // The Run reached every Step, but the last one was interrupted mid-check
  // and produced no assessment: that is not a completely covered journey.
  expect(
    coverageOf([step(0, "assessed"), step(1, "assessed"), step(2, "timed-out")])
  ).toEqual({ complete: false, executed: 3, total: 3, unexecuted: 0 });
});

test("a terminal assessment leaves the remaining Steps unexecuted", () => {
  expect(
    coverageOf([
      step(0, "assessed"),
      step(1, "assessed"),
      step(2, "unexecuted"),
    ])
  ).toEqual({ complete: false, executed: 2, total: 3, unexecuted: 1 });
});
