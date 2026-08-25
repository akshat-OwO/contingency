import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  BUSY_TICK_BEACON,
  CART_STATE_BEACON,
  fixtureServer,
  flow,
  IntegrationLive,
  LAZY_LOADED_BEACON,
  LATE_CONTENT_BEACON,
  runFlow,
  STEP_BEACON,
} from "./harness";

/**
 * Each fixture page paired with the beacon its own script must request. The
 * pairing is what pins fixture to harness constant: a page that stopped
 * naming its beacon would fail here rather than as a mysterious timeout in
 * whichever later ticket leans on it.
 */
const BEACONED_PAGES = [
  ["checkout.html", STEP_BEACON],
  ["lazy.html", LAZY_LOADED_BEACON],
  ["busy.html", BUSY_TICK_BEACON],
  ["late.html", LATE_CONTENT_BEACON],
  ["stateful.html", CART_STATE_BEACON],
] as const;

/**
 * The later stacks' fixtures are registered by the harness, which serves
 * whatever sits in the fixtures directory. This checks registration and the
 * markers later tests will lean on; hover, scroll, and popup behaviour
 * against a real browser is exercised by the tickets that consume them.
 */
it.live("serves every fixture page a later stack tests against", () =>
  Effect.gen(function* checkFixtures() {
    const fixtures = yield* fixtureServer;

    for (const page of [
      "checkout.html",
      "confirmed.html",
      "slow.html",
      "popup.html",
      "popup-target.html",
      "lazy.html",
      "hover.html",
      "violations.html",
      "busy.html",
      "late.html",
      "stateful.html",
    ]) {
      const response = yield* Effect.promise(() => fetch(fixtures.url(page)));
      expect(response.status, page).toBe(200);
      const body = yield* Effect.promise(() => response.text());
      expect(body, page).toContain("<!doctype html>");
    }

    // The beacons are answered — with a 404 — purely so they appear in the
    // request log a test can read.
    for (const [page, beacon] of BEACONED_PAGES) {
      const body = yield* Effect.promise(() =>
        fetch(fixtures.url(page)).then((response) => response.text())
      );
      expect(body, `${page} names its beacon`).toContain(beacon);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

/**
 * The busy page goes busy with no interaction at all, so today's runtime —
 * which can navigate but not yet scroll or hover — can still prove a fixture
 * genuinely fires during a Run: the Run's own page load has to leave ticks in
 * the server's request log.
 */
it.live("busy fixture keeps requesting while a Run is on it", () =>
  Effect.gen(function* watchBusyFixture() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([{ type: "navigate", url: fixtures.url("busy.html") }], "Busy")
    );

    expect(run.outcome).toBe("completed");
    expect(
      fixtures.requests.filter((url) => url === BUSY_TICK_BEACON).length
    ).toBeGreaterThan(0);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
