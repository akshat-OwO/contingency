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

const waitUntil = (ready: () => boolean) =>
  Effect.gen(function* waitForFrames() {
    while (!ready()) {
      yield* Effect.sleep("10 millis");
    }
  }).pipe(Effect.timeout("10 seconds"));

it.live(
  "keeps capturing without viewer acknowledgements and reconnects at the latest frame",
  () =>
    Effect.gen(function* independentCapture() {
      const browser = yield* CreateBrowser;
      const { sessionId } = yield* browser.open(
        undefined,
        animation,
        draftEmulation("default", viewport)
      );
      const received: number[] = [];
      const viewer = yield* browser.stream(sessionId).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "frame") {
              received.push(event.seq);
            }
          })
        ),
        Effect.forkChild
      );
      yield* waitUntil(() => received.length >= 20);
      yield* Fiber.interrupt(viewer);
      const last = received.at(-1) ?? -1;
      yield* Effect.sleep("250 millis");
      const reconnected = yield* browser.stream(sessionId).pipe(
        Stream.filter((event) => event.type === "frame"),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("10 seconds")
      );
      expect(reconnected[0]?.seq).toBeGreaterThan(last);
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
      const release = yield* Deferred.make<boolean>();
      const fast: number[] = [];
      const slow: number[] = [];
      yield* browser.stream(sessionId).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.type === "frame") {
              fast.push(event.seq);
            }
          })
        ),
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
      yield* waitUntil(() => slow.length === 1);
      const first = slow[0] ?? 0;
      yield* waitUntil(() => (fast.at(-1) ?? 0) >= first + 20);
      const latest = fast.at(-1) ?? 0;
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(viewer).pipe(Effect.timeout("10 seconds"));
      expect(slow.at(-1)).toBeGreaterThanOrEqual(latest);
      yield* browser.close(sessionId);
    }).pipe(Effect.scoped, Effect.provide(live))
);
