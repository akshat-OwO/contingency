import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import type { Page } from "playwright-core";

import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import { tryBrowser } from "../../src/services/create-browser-session.ts";
import { CreateBrowserLive } from "../../src/services/create-browser.ts";
import {
  FOOTAGE_MANIFEST_FILE,
  FOOTAGE_VIDEO_FILE,
  FootageManifest,
} from "../../src/services/run-footage.ts";
import {
  RUN_VIDEO_FILE,
  RunVideoRenderer,
  RunVideoRendererLive,
} from "../../src/services/run-video-renderer.ts";
import { makeTimedVideoEncoder } from "../../src/services/timed-video-encoder.ts";

const WIDTH = 640;
const HEIGHT = 400;

const BrowserLive = Layer.merge(CreateBrowserLive, NodeServices.layer);
const RendererLive = RunVideoRendererLive.pipe(Layer.provideMerge(BrowserLive));

const temporaryDirectory = Effect.promise(() =>
  mkdtemp(path.join(tmpdir(), "contingency-run-video-"))
);

/** A solid frame of one colour, as the screencast would hand it over. */
const solidFrame = (page: Page, colour: string) =>
  tryBrowser("Could not paint a frame", async () => {
    await page.setContent(
      `<body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:${colour}"></body>`
    );
    return page.screenshot({ quality: 90, type: "jpeg" });
  });

/** Write real footage: red, then green from 500ms, then blue from 10s. */
const writeFootage = (directory: string) =>
  Effect.scoped(
    Effect.gen(function* recordFootage() {
      const browser = yield* CreateBrowser;
      const page = yield* browser.compositor({ height: HEIGHT, width: WIDTH });
      const red = yield* solidFrame(page, "rgb(220 40 40)");
      const green = yield* solidFrame(page, "rgb(40 200 60)");
      const blue = yield* solidFrame(page, "rgb(40 60 220)");
      const encoder = yield* makeTimedVideoEncoder({
        height: HEIGHT,
        label: "test footage",
        lossy: false,
        output: path.join(directory, FOOTAGE_VIDEO_FILE),
        width: WIDTH,
      });
      yield* encoder.write(red, 0);
      yield* encoder.write(green, 500);
      yield* encoder.write(blue, 10_000);
      yield* encoder.write(blue, 11_000);
      expect(yield* encoder.finish).toBeUndefined();
    })
  );

const manifest: FootageManifest = {
  // Padded to 0–1100 and 9500–10600; the 8.4s between is an Idle Gap.
  actions: [
    { fromMs: 400, toMs: 600 },
    { fromMs: 10_000, toMs: 10_100 },
  ],
  durationMs: 11_000,
  fastForward: "capped",
  frames: [0, 500, 10_000, 11_000],
  height: HEIGHT,
  pointers: [{ action: "click", atMs: 300, durationMs: 200, x: 320, y: 200 }],
  startedAt: Date.parse("2026-10-02T10:00:00.000Z"),
  takeovers: [],
  version: 1,
  width: WIDTH,
};

const writeManifest = (directory: string) =>
  Effect.gen(function* saveManifest() {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(
      path.join(directory, FOOTAGE_MANIFEST_FILE),
      JSON.stringify(Schema.encodeSync(FootageManifest)(manifest))
    );
  });

const awaitReady = (directory: string) =>
  Effect.gen(function* awaitRunVideo() {
    const renderer = yield* RunVideoRenderer;
    yield* renderer.settled(directory).pipe(Effect.timeout("90 seconds"));
    return yield* renderer.status(directory);
  });

interface Region {
  readonly at: number;
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Each region summarised: the share of pixels darker than any test frame,
 * the mean colour, and the brightest pixel's dimmest channel, which is near
 * 255 only for white.
 */
const Sample = Schema.Struct({
  regions: Schema.Array(
    Schema.Struct({
      darkShare: Schema.Finite,
      mean: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite]),
      whitest: Schema.Finite,
    })
  ),
});

/**
 * Decodes the video in Chromium and summarises a region at each moment. It
 * runs in the check page, as page scripts do in the other browser tests.
 */
const samplerScript = `
window.sampleRegions = async (regions) => {
  const video = document.querySelector("video");
  const context = document.querySelector("canvas").getContext("2d");
  if (video.readyState < 2) {
    await new Promise((resolve) => video.addEventListener("loadeddata", resolve, { once: true }));
  }
  const samples = [];
  for (const region of regions) {
    // Seeking and presenting the decoded frame are separate signals.
    // Wait for both before reading pixels, including on a loaded CI runner.
    const sought = new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
    const presented = new Promise((resolve) => video.requestVideoFrameCallback(resolve));
    video.currentTime = region.at;
    await Promise.all([sought, presented]);
    context.drawImage(video, 0, 0);
    const { data } = context.getImageData(region.x, region.y, region.width, region.height);
    let dark = 0;
    let whitest = 0;
    const sum = [0, 0, 0];
    for (let index = 0; index < data.length; index += 4) {
      const [red, green, blue] = [data[index], data[index + 1], data[index + 2]];
      sum[0] += red;
      sum[1] += green;
      sum[2] += blue;
      whitest = Math.max(whitest, Math.min(red, green, blue));
      if (Math.max(red, green, blue) < 90) dark += 1;
    }
    const count = data.length / 4;
    samples.push({ darkShare: dark / count, mean: sum.map((value) => value / count), whitest });
  }
  return { regions: samples };
};`;

const sampleVideo = (file: string, regions: readonly Region[]) =>
  Effect.scoped(
    Effect.gen(function* decodeRunVideo() {
      const fileSystem = yield* FileSystem.FileSystem;
      const bytes = yield* fileSystem.readFile(file);
      const browser = yield* CreateBrowser;
      const page = yield* browser.compositor({ height: HEIGHT, width: WIDTH });
      yield* tryBrowser("Could not serve the video", () =>
        page.route("http://check.invalid/**", (route) =>
          route.request().url().endsWith("/video")
            ? route.fulfill({
                body: Buffer.from(bytes),
                // Without `accept-ranges` the media element cannot seek.
                headers: {
                  "accept-ranges": "bytes",
                  "content-type": "video/webm",
                },
              })
            : route.fulfill({
                body: `<video muted preload="auto" src="/video"></video><canvas width="${WIDTH}" height="${HEIGHT}"></canvas><script>${samplerScript}</script>`,
                contentType: "text/html",
              })
        )
      );
      yield* tryBrowser("Could not open the check page", () =>
        page.goto("http://check.invalid/")
      );
      const sampled = yield* tryBrowser("Could not sample the video", () =>
        page.evaluate<unknown>(
          `window.sampleRegions(${JSON.stringify(regions)})`
        )
      );
      return yield* Schema.decodeUnknownEffect(Sample)(sampled);
    })
  );

it.live(
  "condenses footage: real-time actions, a capped Idle Gap with its badge, and the agent cursor",
  () =>
    Effect.gen(function* condenseRunFootage() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* temporaryDirectory;
      yield* writeFootage(directory);
      yield* writeManifest(directory);

      const status = yield* awaitReady(directory);
      expect(status).toEqual({ condensed: true, state: "ready" });
      // The real-time footage does not outlive the condensed video.
      expect(
        yield* fileSystem.exists(path.join(directory, FOOTAGE_VIDEO_FILE))
      ).toBe(false);
      expect(
        yield* fileSystem.exists(path.join(directory, FOOTAGE_MANIFEST_FILE))
      ).toBe(false);
      expect(
        yield* fileSystem.exists(path.join(directory, RUN_VIDEO_FILE))
      ).toBe(true);

      // The arrow's 20px box hangs below and right of its tip at (320, 200);
      // the badge pill sits in the bottom-right corner.
      const arrow = { height: 16, width: 16, x: 320, y: 200 };
      const corner = { height: 18, width: 30, x: WIDTH - 50, y: HEIGHT - 32 };
      const sample = yield* sampleVideo(path.join(directory, RUN_VIDEO_FILE), [
        // Run 600ms: the cursor has landed, over the green frame.
        { at: 0.6, ...arrow },
        // Before the agent points there is no cursor, over red.
        { at: 0.1, ...arrow },
        // The badge, inside the Idle Gap and outside it.
        { at: 2.5, ...corner },
        { at: 0.2, ...corner },
        // Past the gap, the blue frame plays in real time.
        { at: 5.3, height: 10, width: 10, x: 40, y: 40 },
      ]);
      const [cursor, beforeCursor, badge, noBadge, blue] = sample.regions;
      // The arrow's white fill, which none of the frames contain.
      expect(cursor?.whitest).toBeGreaterThan(200);
      expect(beforeCursor?.whitest).toBeLessThan(120);
      expect(beforeCursor?.mean[0]).toBeGreaterThan(150);
      // The dark pill over the green frame, absent in real time.
      expect(badge?.darkShare).toBeGreaterThan(0.4);
      expect(noBadge?.darkShare).toBe(0);
      expect(blue?.mean[2]).toBeGreaterThan(150);
    }).pipe(Effect.provide(RendererLive))
);

it.live(
  "keeps each footage frame at its own stamp when repaints come at a steady rate",
  () =>
    Effect.gen(function* encodeSteadyRepaints() {
      const directory = yield* temporaryDirectory;
      const file = path.join(directory, FOOTAGE_VIDEO_FILE);
      yield* Effect.scoped(
        Effect.gen(function* recordCaretBlink() {
          const browser = yield* CreateBrowser;
          const page = yield* browser.compositor({
            height: HEIGHT,
            width: WIDTH,
          });
          const red = yield* solidFrame(page, "rgb(220 40 40)");
          const green = yield* solidFrame(page, "rgb(40 200 60)");
          const blue = yield* solidFrame(page, "rgb(40 60 220)");
          const encoder = yield* makeTimedVideoEncoder({
            height: HEIGHT,
            label: "test footage",
            lossy: false,
            output: file,
            width: WIDTH,
          });
          // A Page that loads, then sits with a caret blinking at 2fps; on a
          // half-second clock the first blink would show at 3.5s.
          yield* encoder.write(red, 0);
          yield* encoder.write(green, 56);
          for (const atMs of [3509, 4009, 4509, 5009, 5509, 6009]) {
            yield* encoder.write(blue, atMs);
          }
          expect(yield* encoder.finish).toBeUndefined();
        })
      );
      const region = { height: 10, width: 10, x: 40, y: 40 };
      const sample = yield* sampleVideo(file, [
        { at: 0.1, ...region },
        { at: 3.504, ...region },
        { at: 3.52, ...region },
      ]);
      const [loaded, beforeBlink, blinking] = sample.regions;
      expect(loaded?.mean[1]).toBeGreaterThan(150);
      expect(beforeBlink?.mean[1]).toBeGreaterThan(150);
      expect(blinking?.mean[2]).toBeGreaterThan(150);
    }).pipe(Effect.provide(RendererLive))
);

it.live(
  "keeps the real-time footage as the video when it cannot be condensed",
  () =>
    Effect.gen(function* fallBackToFootage() {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* temporaryDirectory;
      yield* fileSystem.writeFileString(
        path.join(directory, FOOTAGE_VIDEO_FILE),
        "not a video"
      );
      yield* writeManifest(directory);

      const status = yield* awaitReady(directory);
      expect(status.state).toBe("ready");
      if (status.state !== "ready" || status.condensed) {
        return yield* Effect.die("Expected an uncondensed video.");
      }
      expect(status.reason.length).toBeGreaterThan(0);
      expect(
        yield* fileSystem.readFileString(path.join(directory, RUN_VIDEO_FILE))
      ).toBe("not a video");
      expect(
        yield* fileSystem.exists(path.join(directory, FOOTAGE_MANIFEST_FILE))
      ).toBe(false);
    }).pipe(Effect.provide(RendererLive))
);

it.live("reports a directory without footage as having no video", () =>
  Effect.gen(function* noFootage() {
    const renderer = yield* RunVideoRenderer;
    const directory = yield* temporaryDirectory;
    expect(yield* renderer.status(directory)).toEqual({ state: "unavailable" });
  }).pipe(Effect.provide(RendererLive))
);
