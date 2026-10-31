import { EventEmitter } from "node:events";

import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { NetworkMonitor } from "lighthouse/core/gather/driver/network-monitor.js";
import {
  waitForFcp,
  waitForFullyLoaded,
} from "lighthouse/core/gather/driver/wait-for-condition.js";

import {
  LIGHTHOUSE_FCP_WAIT_MS,
  LIGHTHOUSE_LOAD_WAIT_MS,
  LIGHTHOUSE_PROCESSING_ALLOWANCE_MS,
  SCAN_GUARD_MS,
  SCAN_RELOAD_COMMIT_WAIT_MS,
} from "../../src/services/scan-budgets.ts";

/** Lighthouse enforces this post-FCP pause for provided throttling. */
const PAUSE_AFTER_FCP_MS = 5250;

type Session = Parameters<typeof waitForFullyLoaded>[0];

/** A wait that never resolves: the page never loads or goes quiet. */
const pending = () => ({
  cancel: () => {},
  promise: Promise.withResolvers<undefined>().promise,
});

/** Let promise chains settle between timers, as the event loop would. */
const settle = async (turns = 50): Promise<void> => {
  if (turns > 0) {
    await Promise.resolve();
    await settle(turns - 1);
  }
};

/**
 * Run Lighthouse's global timers in virtual time, so no wall-clock time
 * passes while its load and FCP deadlines race.
 */
const virtualTimers = () => {
  let now = 0;
  let nextId = 0;
  const due = new Map<
    number,
    { readonly at: number; readonly run: () => void }
  >();
  const fireUntil = async (target: number): Promise<void> => {
    await settle();
    const [next] = [...due.entries()]
      .filter(([, timer]) => timer.at <= target)
      .toSorted(([, a], [, b]) => a.at - b.at);
    if (next === undefined) {
      now = target;
      return;
    }
    due.delete(next[0]);
    now = next[1].at;
    next[1].run();
    await fireUntil(target);
  };
  return {
    advance: async (ms: number) => {
      await fireUntil(now + ms);
      await settle();
    },
    clearTimeout: (id: number) => due.delete(id),
    setTimeout: (run: () => void, ms = 0) => {
      nextId += 1;
      due.set(nextId, { at: now + ms, run });
      return nextId;
    },
  };
};

it("leaves processing time between Lighthouse page waits and the scan hang guard", () => {
  expect(
    LIGHTHOUSE_LOAD_WAIT_MS + LIGHTHOUSE_PROCESSING_ALLOWANCE_MS
  ).toBeLessThan(SCAN_GUARD_MS);
  expect(SCAN_RELOAD_COMMIT_WAIT_MS).toBeLessThan(SCAN_GUARD_MS);
});

it("returns a timed-out load, not NO_FCP, for a page that paints late and never settles", async () => {
  const timers = virtualTimers();
  const real = {
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout,
  };
  Object.assign(globalThis, {
    clearTimeout: timers.clearTimeout,
    setTimeout: timers.setTimeout,
  });
  try {
    // oxlint-disable-next-line unicorn/prefer-event-target -- Lighthouse's CDP session is EventEmitter-shaped.
    const events = new EventEmitter();
    // SAFETY: waitForFullyLoaded only calls on, off, once, sendCommand,
    // sendCommandAndIgnore, setNextProtocolTimeout and onCrashPromise on the session.
    const session = Object.assign(events, {
      onCrashPromise: () => Promise.withResolvers<never>().promise,
      sendCommand: () => Promise.resolve({}),
      sendCommandAndIgnore: () => Promise.resolve(),
      setNextProtocolTimeout: () => {},
    }) as Session;
    // SAFETY: with these overrides, waitForFullyLoaded reads only getInflightRequests,
    // so the monitor needs no CDP target.
    const network = Object.create(NetworkMonitor.prototype) as NetworkMonitor;
    network.getInflightRequests = () => [];
    const outcome = Effect.runPromise(
      Effect.result(
        Effect.tryPromise(() =>
          waitForFullyLoaded(session, network, {
            _waitForTestOverrides: {
              waitForCPUIdle: pending,
              waitForFcp,
              waitForLoadEvent: pending,
              waitForNetworkIdle: pending,
            },
            cpuQuietThresholdMs: 1000,
            maxWaitForFcpMs: LIGHTHOUSE_FCP_WAIT_MS,
            maxWaitForLoadedMs: LIGHTHOUSE_LOAD_WAIT_MS,
            networkQuietThresholdMs: 1000,
            pauseAfterFcpMs: PAUSE_AFTER_FCP_MS,
            pauseAfterLoadMs: PAUSE_AFTER_FCP_MS,
          })
        )
      )
    );
    await timers.advance(10_000);
    events.emit("Page.lifecycleEvent", { name: "firstContentfulPaint" });
    await timers.advance(LIGHTHOUSE_LOAD_WAIT_MS);
    const settled = await outcome;
    expect(
      Result.isSuccess(settled)
        ? settled.success
        : String(settled.failure.cause)
    ).toEqual({
      timedOut: true,
    });
  } finally {
    Object.assign(globalThis, real);
  }
});
