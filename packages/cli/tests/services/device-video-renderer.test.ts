import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import type { Scope } from "effect";

import { CreateBrowser } from "../../src/services/create-browser-contract.ts";
import {
  DEVICE_CAPTURE_FILE,
  DEVICE_VIDEO_FILE,
} from "../../src/services/device-video-capture.ts";
import type { DeviceCaptureManifest } from "../../src/services/device-video-capture.ts";
import {
  DeviceVideoRenderer,
  DeviceVideoRendererLive,
} from "../../src/services/device-video-renderer.ts";
import type { DeviceVideoRendererService } from "../../src/services/device-video-renderer.ts";

/** Status reads never render, so they never reach a browser. */
const UnusedBrowser = Layer.mock(CreateBrowser, {});

const recorded: DeviceCaptureManifest = {
  actions: [],
  budgetExceeded: false,
  endedAt: 13_000,
  fastForward: "capped",
  files: ["recording.mp4"],
  hidden: [],
  pacing: "real-time",
  platform: "android",
  recorder: "confirmed",
  startedAt: 10_000,
  state: "recorded",
  takeovers: [],
  version: 1,
};

const folderWith = (
  manifest?: DeviceCaptureManifest,
  files: Record<string, string> = {}
) =>
  Effect.gen(function* makeCaptureFolder() {
    const fileSystem = yield* FileSystem.FileSystem;
    const folder = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "device-video-renderer-",
    });
    if (manifest !== undefined) {
      yield* fileSystem.writeFileString(
        path.join(folder, DEVICE_CAPTURE_FILE),
        JSON.stringify(manifest)
      );
    }
    for (const [name, contents] of Object.entries(files)) {
      yield* fileSystem.writeFileString(path.join(folder, name), contents);
    }
    return folder;
  });

const status = (folder: string, live = false) =>
  DeviceVideoRenderer.pipe(
    Effect.flatMap((renderer) => renderer.status(folder, live))
  );

const provided = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    DeviceVideoRendererService | FileSystem.FileSystem | Scope.Scope
  >
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      DeviceVideoRendererLive.pipe(
        Layer.provide(UnusedBrowser),
        Layer.provideMerge(NodeServices.layer)
      )
    )
  );

describe("DeviceVideoRenderer.status", () => {
  it.effect("says a session from before device video kept none", () =>
    provided(
      Effect.gen(function* legacy() {
        const folder = yield* folderWith();
        expect(yield* status(folder)).toMatchObject({ state: "not-recorded" });
      })
    )
  );

  it.effect("passes on why the recorder never started", () =>
    provided(
      Effect.gen(function* notRecorded() {
        const folder = yield* folderWith({
          ...recorded,
          endedAt: null,
          files: [],
          reason: "This device offers no screen recorder.",
          startedAt: null,
          state: "not-recorded",
        });
        expect(yield* status(folder)).toEqual({
          reason:
            "No video was recorded. This device offers no screen recorder.",
          state: "not-recorded",
        });
      })
    )
  );

  it.effect(
    "tells a recording still under way from one a process left unfinished",
    () =>
      provided(
        Effect.gen(function* unfinished() {
          const folder = yield* folderWith({
            ...recorded,
            endedAt: null,
            state: "recording",
          });
          expect(yield* status(folder, true)).toEqual({ state: "preparing" });
          expect(yield* status(folder, false)).toMatchObject({
            reason: expect.stringContaining("interrupted"),
            state: "unavailable",
          });
        })
      )
  );

  it.effect("plays the rendered video with the session's time map", () =>
    provided(
      Effect.gen(function* rendered() {
        const folder = yield* folderWith(recorded, {
          [DEVICE_VIDEO_FILE]: "webm",
        });
        expect(yield* status(folder)).toMatchObject({
          capture: { complete: true },
          pacing: "real-time",
          path: path.join(folder, DEVICE_VIDEO_FILE),
          state: "ready",
          timeMap: {
            segments: [{ runFromMs: 0, runToMs: 3000 }],
            startedAt: new Date(10_000).toISOString(),
          },
        });
      })
    )
  );

  it.effect("plays the raw footage in real time when rendering failed", () =>
    provided(
      Effect.gen(function* fallback() {
        const folder = yield* folderWith(
          {
            ...recorded,
            files: ["recording.mp4", "recording-1.mp4"],
            pacing: "condensed",
          },
          {
            "fallback.json": JSON.stringify({
              reason: "The footage could not be decoded (4).",
            }),
            "recording.mp4": "mp4",
          }
        );
        expect(yield* status(folder)).toMatchObject({
          fallback:
            "The footage could not be decoded (4). Playing the raw recording. Only its first part, about 3 minutes, plays here.",
          pacing: "real-time",
          path: path.join(folder, "recording.mp4"),
          state: "ready",
        });
      })
    )
  );

  it.effect("says a recorded video is gone when its files are", () =>
    provided(
      Effect.gen(function* missing() {
        const folder = yield* folderWith(recorded);
        expect(yield* status(folder)).toMatchObject({
          directory: folder,
          reason: expect.stringContaining("no longer in this session's folder"),
          state: "unavailable",
        });
      })
    )
  );

  it.effect("reports a recorder that kept no footage", () =>
    provided(
      Effect.gen(function* failed() {
        const folder = yield* folderWith({
          ...recorded,
          files: [],
          reason: "The device's screen recorder kept no footage.",
          state: "failed",
        });
        expect(yield* status(folder)).toMatchObject({
          reason: "The device's screen recorder kept no footage.",
          state: "unavailable",
        });
      })
    )
  );
});
