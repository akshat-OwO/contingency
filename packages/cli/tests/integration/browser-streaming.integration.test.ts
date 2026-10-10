import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";

import {
  CreateBrowser,
  CreateBrowserLive,
} from "../../src/services/create-browser.ts";
import { draftEmulation } from "./harness.ts";

const viewport = { deviceScaleFactor: 1, height: 480, width: 640 };
const live = Layer.merge(CreateBrowserLive, NodeServices.layer);
const animation = `data:text/html,${encodeURIComponent('<main>Streaming</main><script>let tick = 0; setInterval(() => { document.body.style.background = "hsl(" + tick++ % 360 + " 80% 50%)"; }, 25);</script>')}`;

/**
 * Reconnecting proves capture went on without the first viewer: a newer frame
 * than it last saw arrives, acknowledged by no one.
 */
it.live(
  "keeps capturing without viewer acknowledgements and reconnects to a newer frame",
  () =>
    Effect.gen(function* independentCapture() {
      const browser = yield* CreateBrowser;
      const { sessionId } = yield* browser.open(
        undefined,
        animation,
        draftEmulation("default", viewport)
      );
      const received = yield* browser.stream(sessionId).pipe(
        Stream.filter((event) => event.type === "frame"),
        Stream.take(20),
        Stream.runCollect,
        Effect.timeout("10 seconds")
      );
      const last = received.at(-1)?.seq ?? -1;
      const reconnected = yield* browser.stream(sessionId).pipe(
        Stream.filter((event) => event.type === "frame" && event.seq > last),
        Stream.runHead,
        Effect.timeout("10 seconds")
      );
      expect(reconnected._tag).toBe("Some");
      yield* browser.close(sessionId);
    }).pipe(Effect.scoped, Effect.provide(live))
);

it.live(
  "lets a slow viewer skip old frames without slowing another viewer",
  () =>
    Effect.gen(function* slowViewer() {
      const browser = yield* CreateBrowser;
      const { sessionId } = yield* browser.open(
        undefined,
        animation,
        draftEmulation("default", viewport)
      );
      const release = yield* Deferred.make<true>();
      // Completed by the fast viewer once it is 20 frames past the frame the
      // slow viewer is still stuck on.
      const fastAhead = yield* Deferred.make<number>();
      const slow: number[] = [];
      yield* browser.stream(sessionId).pipe(
        Stream.runForEach((event) => {
          const [first] = slow;
          return event.type === "frame" &&
            first !== undefined &&
            event.seq >= first + 20
            ? Deferred.succeed(fastAhead, event.seq)
            : Effect.void;
        }),
        Effect.forkChild
      );
      const viewer = yield* browser.stream(sessionId).pipe(
        Stream.filter((event) => event.type === "frame"),
        Stream.take(4),
        Stream.runForEach((event) =>
          Effect.gen(function* consumeSlowFrame() {
            slow.push(event.seq);
            if (slow.length === 1) {
              yield* Deferred.await(release);
            }
          })
        ),
        Effect.forkChild
      );
      const latest = yield* Deferred.await(fastAhead).pipe(
        Effect.timeout("10 seconds")
      );
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(viewer).pipe(Effect.timeout("10 seconds"));
      expect(slow.at(-1)).toBeGreaterThanOrEqual(latest);
      yield* browser.close(sessionId);
    }).pipe(Effect.scoped, Effect.provide(live))
);
