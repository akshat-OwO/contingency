import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { Page } from "playwright-core";

import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";
import { RecordingLive } from "../../src/services/recorder.ts";
import { Recording } from "../../src/services/recording.ts";
import { RunnerLive } from "../../src/services/runner.ts";
import {
  CART_VIEWED_BEACON,
  draftEmulation,
  fixtureServer,
  runFlow,
} from "./harness.ts";

/**
 * The whole product in one line: a Flow authored by recording in Create View,
 * replayed headlessly by the Runner.
 *
 * Nothing here is faked. The Recording is driven over a real browser through
 * the same machinery Create View uses, and the Run executes through the real
 * Runner against the same served pages — so this file falsifies exactly what
 * ticket #55 promises: a recorded shop session that spans Pages replays with
 * every Step resolving.
 */
const EndToEndLive = RecordingLive.pipe(
  Layer.provideMerge(CreateBrowserLive),
  Layer.provideMerge(RunnerLive),
  Layer.provideMerge(NodeServices.layer)
);

const viewport = { deviceScaleFactor: 1, height: 480, width: 640 } as const;

it.live(
  "replays a recorded shop Flow — popup included — as a Run where every Step resolves",
  () =>
    Effect.gen(function* recordThenReplay() {
      const fixtures = yield* fixtureServer;
      const browser = yield* CreateBrowser;
      const recording = yield* Recording;

      const sessionId = yield* browser.create(
        `create-end-to-end-${Date.now()}`,
        viewport
      );
      yield* Effect.addFinalizer(() =>
        browser.close(sessionId).pipe(Effect.ignore)
      );

      // The opening navigation becomes the Flow's first Step, exactly as an
      // author's arrival at the shop does.
      yield* browser.open(
        sessionId,
        fixtures.url("shop.html"),
        draftEmulation("chrome-windows", viewport)
      );
      yield* recording.start({ sessionId, title: "Anvil Works" });
      const { page } = yield* browser.recorderTarget(sessionId);

      // Browse: type into the catalogue search.
      yield* Effect.promise(() => page.fill("#search", "giant"));
      yield* Effect.sleep("300 millis");

      // Buy: add to cart, which opens the checkout in another Page. The Page
      // event is awaited from before the click so the popup cannot slip past
      // capture in between.
      const opened = Effect.promise((): Promise<Page> =>
        page.context().waitForEvent("page")
      );
      const [popup] = yield* Effect.all(
        [opened, Effect.promise(() => page.click("#add"))],
        { concurrency: 2 }
      );
      yield* Effect.promise(() => popup.waitForLoadState("domcontentloaded"));

      // The cart Page is live, so capture has followed it; acting goes
      // through the popup's own handle.
      yield* Effect.promise(() => popup.click("#place-order"));
      yield* Effect.sleep("300 millis");

      // Return to the shop and view the cart there.
      yield* Effect.promise(() => page.click("#view-cart"));
      yield* Effect.sleep("300 millis");

      const finished = yield* recording.finish();
      expect(finished.phase).toBe("finished");

      const { steps } = finished.flow;
      expect(steps.map((step) => step.type)).toEqual([
        "navigate",
        "change",
        "click",
        "click",
        "click",
      ]);
      // The two cart Steps name the Pages they were recorded against: the
      // order placed in the popup, and the cart viewed back on the shop.
      expect(steps[3]).toMatchObject({ page: 1 });
      expect(steps[4]).not.toHaveProperty("page");

      const { persisted, run } = yield* runFlow(finished.flow);
      expect(run.outcome).toBe("completed");
      expect(run.steps.map((step) => step.outcome)).toEqual([
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
      ]);
      expect(persisted.outcome).toBe("completed");

      // The replay did the shopping, not merely resolved selectors: the
      // order reached the server and the shop registered its cart view.
      expect(
        fixtures.requests.some((url) => url.startsWith("/confirmed"))
      ).toBe(true);
      expect(fixtures.requests).toContain(CART_VIEWED_BEACON);
    }).pipe(Effect.scoped, Effect.provide(EndToEndLive))
);
