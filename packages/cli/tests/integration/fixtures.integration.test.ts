import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import {
  BUSY_TICK_BEACON,
  CART_STATE_BEACON,
  fixtureServer,
  LAZY_LOADED_BEACON,
  LATE_CONTENT_BEACON,
  LOAD_READY_BEACON,
  SCROLL_READY_BEACON,
  SETTLE_GATE,
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
  ["scroll-readiness.html", SCROLL_READY_BEACON],
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
      "scroll-readiness.html",
      "scroll-busy.html",
      "scroll-redirect.html",
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

it.live("signals future matching requests after recording their headers", () =>
  Effect.gen(function* requestSignals() {
    const fixtures = yield* fixtureServer;
    const first = yield* fixtures.awaitRequest((url) => url === STEP_BEACON);
    const second = yield* fixtures.awaitRequest((url) => url === STEP_BEACON);
    const other = yield* fixtures.awaitRequest(
      (url) => url === CART_STATE_BEACON
    );

    yield* Effect.promise(() => fetch(fixtures.url("checkout.html")));
    expect(yield* Deferred.isDone(first)).toBe(false);
    yield* Effect.promise(() => fetch(`${fixtures.origin}${STEP_BEACON}`));
    for (const arrived of [first, second]) {
      expect(
        yield* Deferred.await(arrived).pipe(Effect.timeout("30 seconds"))
      ).toBe(STEP_BEACON);
    }
    expect(fixtures.requestHeaders.at(-1)?.url).toBe(STEP_BEACON);
    expect(yield* Deferred.isDone(other)).toBe(false);

    // Registration observes future requests, so repeated beacons can be counted.
    const next = yield* fixtures.awaitRequest((url) => url === STEP_BEACON);
    expect(yield* Deferred.isDone(next)).toBe(false);
    yield* Effect.promise(() => fetch(`${fixtures.origin}${STEP_BEACON}`));
    expect(yield* Deferred.await(next).pipe(Effect.timeout("30 seconds"))).toBe(
      STEP_BEACON
    );
    expect(fixtures.requests.filter((url) => url === STEP_BEACON)).toHaveLength(
      2
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live(
  "holds load and navigation responses until the test releases them",
  () =>
    Effect.gen(function* responseGates() {
      const fixtures = yield* fixtureServer;
      for (const pathname of [LOAD_READY_BEACON, SETTLE_GATE]) {
        const gate = yield* pathname === LOAD_READY_BEACON
          ? fixtures.holdLoadBeacon()
          : fixtures.holdRequest(pathname);
        const answered = yield* Deferred.make<number>();
        const request = yield* Effect.gen(function* readHeldResponse() {
          const response = yield* Effect.promise(() =>
            fetch(`${fixtures.origin}${pathname}`)
          );
          expect(yield* Effect.promise(() => response.text())).toBe("ready");
          yield* Deferred.succeed(answered, response.status);
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(gate.arrived).pipe(Effect.timeout("30 seconds"));
        expect(yield* Deferred.isDone(answered)).toBe(false);
        yield* Deferred.succeed(gate.release, null);
        expect(
          yield* Deferred.await(answered).pipe(Effect.timeout("30 seconds"))
        ).toBe(200);
        yield* Fiber.join(request);
        // Each hold is consumed once; unrelated callers get an immediate response.
        const unheld = yield* Effect.promise(() =>
          fetch(`${fixtures.origin}${pathname}`)
        );
        expect(unheld.status).toBe(200);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("removes unconsumed response gates when their scope closes", () =>
  Effect.gen(function* gateCleanup() {
    const fixtures = yield* fixtureServer;
    yield* fixtures.holdLoadBeacon().pipe(Effect.scoped);
    const response = yield* Effect.promise(() =>
      fetch(`${fixtures.origin}${LOAD_READY_BEACON}`)
    ).pipe(Effect.timeout("30 seconds"));
    expect(response.status).toBe(200);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("closes an arrived response when its hold scope closes", () =>
  Effect.gen(function* arrivedGateCleanup() {
    const fixtures = yield* fixtureServer;
    const failed = yield* Deferred.make<Error>();
    const outerScope = yield* Effect.scope;
    yield* Effect.gen(function* abandonHeldResponse() {
      const gate = yield* fixtures.holdLoadBeacon();
      yield* Effect.gen(function* readAbandonedResponse() {
        const error = yield* Effect.flip(
          Effect.tryPromise({
            catch: (cause) => new Error("Held request closed", { cause }),
            try: () => fetch(`${fixtures.origin}${LOAD_READY_BEACON}`),
          })
        );
        yield* Deferred.succeed(failed, error);
      }).pipe(Effect.forkIn(outerScope));
      yield* Deferred.await(gate.arrived).pipe(Effect.timeout("30 seconds"));
    }).pipe(Effect.scoped);
    expect(
      yield* Deferred.await(failed).pipe(Effect.timeout("30 seconds"))
    ).toBeInstanceOf(Error);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live("does not replay a request into its observer's next waiter", () =>
  Effect.gen(function* nextRequestSignal() {
    const fixtures = yield* fixtureServer;
    const first = yield* fixtures.awaitRequest((url) => url === STEP_BEACON);
    const observer = yield* Effect.gen(function* registerNextRequest() {
      yield* Deferred.await(first);
      return yield* fixtures.awaitRequest((url) => url === STEP_BEACON);
    }).pipe(Effect.forkScoped);
    yield* Effect.promise(() => fetch(`${fixtures.origin}${STEP_BEACON}`));
    const next = yield* Fiber.join(observer).pipe(Effect.timeout("30 seconds"));
    expect(yield* Deferred.isDone(next)).toBe(false);
    yield* Effect.promise(() => fetch(`${fixtures.origin}${STEP_BEACON}`));
    expect(yield* Deferred.await(next).pipe(Effect.timeout("30 seconds"))).toBe(
      STEP_BEACON
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
