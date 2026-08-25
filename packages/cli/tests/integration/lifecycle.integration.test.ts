import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { flowRunsDirectory } from "../../src/services/runner.ts";
import {
  BUSY_TICK_BEACON,
  CART_STATE_BEACON,
  fixtureServer,
  flow,
  IntegrationLive,
  LATE_CONTENT_BEACON,
  runFlow,
} from "./harness";

/**
 * A Run starts from a fresh browser context and ends only once its Page has
 * gone quiet (ADR 0015).
 */
const addToCart = (url: string) =>
  flow([
    { type: "navigate", url },
    {
      target: [{ kind: "role", name: "Add anvil to cart", role: "button" }],
      type: "click",
    },
  ]);

/**
 * What the stateful fixture beaconed at load, in order — the record of what
 * cart each Run started from, as the server saw it.
 */
const cartsAtLoad = (requests: readonly string[]): readonly string[] =>
  requests.filter((url) => url.startsWith(CART_STATE_BEACON));

it.live(
  "a second Run of a Flow starts where the first one did: at nothing",
  () =>
    Effect.gen(function* replayIsolated() {
      const fixtures = yield* fixtureServer;

      yield* runFlow(addToCart(fixtures.url("stateful.html")));
      yield* runFlow(addToCart(fixtures.url("stateful.html")));

      // The fixture keeps its cart in origin storage, so a context that carried
      // the first Run's state would have loaded with one item already in it.
      expect(cartsAtLoad(fixtures.requests)).toEqual([
        `${CART_STATE_BEACON}?at-load=0`,
        `${CART_STATE_BEACON}?at-load=0`,
      ]);
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("a Flow that opts into persisted state carries its cart", () =>
  Effect.gen(function* replayPersisted() {
    const fixtures = yield* fixtureServer;
    const fileSystem = yield* FileSystem.FileSystem;
    // One output directory across both Runs: the snapshot lives beside a
    // Flow's Run history, keyed by its identity.
    const shared = yield* fileSystem.makeTempDirectoryScoped({
      directory: tmpdir(),
      prefix: "contingency-integration-persisted-",
    });

    const persistedFlow = {
      ...addToCart(fixtures.url("stateful.html")),
      persistedState: true,
    };
    yield* runFlow(persistedFlow, { outputDirectory: shared });
    yield* runFlow(persistedFlow, { outputDirectory: shared });

    // The second Run restored what the first saved, and its own end state is
    // saved in turn for whichever Run follows it.
    expect(cartsAtLoad(fixtures.requests)).toEqual([
      `${CART_STATE_BEACON}?at-load=0`,
      `${CART_STATE_BEACON}?at-load=1`,
    ]);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

/**
 * A snapshot Playwright cannot restore must degrade to a fresh context, not
 * fail the Run at context-open — because a failed Run never writes a
 * replacement, an unrestorable file would otherwise brick every later Run of
 * the Flow until someone deleted it by hand.
 */
it.live("an unrestorable snapshot starts the next Run fresh, not broken", () =>
  Effect.gen(function* replayCorruptSnapshot() {
    const fixtures = yield* fixtureServer;
    const fileSystem = yield* FileSystem.FileSystem;
    const shared = yield* fileSystem.makeTempDirectoryScoped({
      directory: tmpdir(),
      prefix: "contingency-integration-persisted-",
    });

    const persistedFlow = {
      ...addToCart(fixtures.url("stateful.html")),
      persistedState: true,
    };
    yield* runFlow(persistedFlow, { outputDirectory: shared });

    // Parseable JSON with a cookies array — but a cookie entry Playwright's
    // own validation refuses: no name, no value, no url. The shape a hand
    // edit or another era could plausibly leave behind.
    const statePath = path.join(
      flowRunsDirectory(shared, persistedFlow),
      "storage-state.json"
    );
    yield* fileSystem.writeFileString(
      statePath,
      `${JSON.stringify({ cookies: [{ domain: "127.0.0.1" }], origins: [] })}\n`
    );

    const { run } = yield* runFlow(persistedFlow, { outputDirectory: shared });

    expect(run.outcome).toBe("completed");
    expect(cartsAtLoad(fixtures.requests).at(-1)).toBe(
      `${CART_STATE_BEACON}?at-load=0`
    );
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

/**
 * The busy page never settles, so this Run ends by losing an argument: the
 * quiescence wait costs its bound and gives up. That makes both halves of the
 * contract observable in one request log — the wait happened, and it ended.
 */
it.live("a busy Page holds the Run briefly, then loses the argument", () =>
  Effect.gen(function* replayBoundedWait() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([{ type: "navigate", url: fixtures.url("busy.html") }], "Busy")
    );

    expect(run.outcome).toBe("completed");
    const ticks = fixtures.requests.filter(
      (url) => url === BUSY_TICK_BEACON
    ).length;
    // Without the end-of-run wait the context closes the moment load fires,
    // leaving exactly the first tick behind. Staying means more arrived.
    expect(ticks).toBeGreaterThanOrEqual(5);
    // Bounded: two seconds of ticks plus slack, not a Page that never
    // settles stretching the Run out indefinitely.
    expect(ticks).toBeLessThan(100);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

/**
 * The late fixture injects its content 700ms after load. A Run that tore down
 * at its final Step would close the context before the content existed; that
 * the server saw the settled page's beacon means the Run waited for it.
 */
it.live("a late-rendering Page finishes arriving before the Run ends", () =>
  Effect.gen(function* replayLateContent() {
    const fixtures = yield* fixtureServer;

    const { run } = yield* runFlow(
      flow([{ type: "navigate", url: fixtures.url("late.html") }])
    );

    expect(run.outcome).toBe("completed");
    expect(fixtures.requests).toContain(LATE_CONTENT_BEACON);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
