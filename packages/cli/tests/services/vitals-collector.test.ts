import { runInNewContext } from "node:vm";

import { expect, it } from "@effect/vitest";

import { VITALS_COLLECTOR } from "../../src/services/vitals-collector";
import { VITALS_GLOBAL } from "../../src/services/vitals-recorder";

interface RecordedVitals {
  firstInput: { duration: number; startTime: number } | null;
  interactions: Record<string, number>;
  lcp: number | null;
  shifts: { startTime: number; value: number }[];
}

interface Collected {
  cls: number;
  fcp: number | null;
  inp: number | null;
  lcp: number | null;
  ttfb: number | null;
}

/**
 * Run the collector exactly as it is shipped, against a page that recorded
 * `recorded`. The expression only reaches the page through `window` and
 * `performance`, so both can be supplied.
 */
const collect = async (
  recorded: Partial<RecordedVitals>
): Promise<Collected> => {
  const state: RecordedVitals = {
    firstInput: null,
    interactions: {},
    lcp: null,
    shifts: [],
    ...recorded,
  };
  const page = {
    getEntriesByName: (name: string) =>
      name === "first-contentful-paint" ? [{ startTime: 42 }] : [],
    getEntriesByType: (type: string) =>
      type === "navigation" ? [{ responseStart: 7 }] : [],
    now: () => 0,
  };
  const collected = (await runInNewContext(VITALS_COLLECTOR, {
    performance: page,
    setTimeout,
    window: { [VITALS_GLOBAL]: state },
  })) as string;
  return JSON.parse(collected) as Collected;
};

it("scores CLS as the worst session window, not the total", async () => {
  // Two shifts far enough apart to be unrelated. Summing them reports a page
  // as twice as unstable as it is.
  const { cls } = await collect({
    shifts: [
      { startTime: 100, value: 0.1 },
      { startTime: 1600, value: 0.1 },
    ],
  });

  expect(cls).toBe(0.1);
});

it("keeps shifts within a second of each other in one session", async () => {
  const { cls } = await collect({
    shifts: [
      { startTime: 100, value: 0.1 },
      { startTime: 600, value: 0.1 },
    ],
  });

  expect(cls).toBeCloseTo(0.2, 10);
});

it("closes a CLS session five seconds after it opened", async () => {
  // Every shift is under a second from the last, so only the five-second cap
  // ends the session.
  const shifts = Array.from({ length: 8 }, (_unused, index) => ({
    startTime: 100 + index * 800,
    value: 0.05,
  }));

  const { cls } = await collect({ shifts });

  // Seven fit the window; the eighth opens a new one.
  expect(cls).toBeCloseTo(0.35, 10);
});

it("reports the worst interaction as INP", async () => {
  const { inp } = await collect({
    interactions: { "1": 40, "2": 152, "3": 88 },
  });

  expect(inp).toBe(152);
});

it("reports INP for an interaction too fast to be an event entry", async () => {
  // The event observer cannot report below its own floor, so a very
  // responsive page would otherwise read exactly like an untouched one.
  const { inp } = await collect({
    firstInput: { duration: 8, startTime: 120 },
  });

  expect(inp).toBe(8);
});

it("reports no INP for a page nobody interacted with", async () => {
  const { inp } = await collect({});

  expect(inp).toBeNull();
});
