import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, FileSystem, Option } from "effect";
import { TestClock } from "effect/testing";

import {
  DEVICE_CAPTURE_FILE,
  DEVICE_VIDEO_DIRECTORY,
  makeDeviceVideoCapture,
  readDeviceCapture,
} from "../../src/services/device-video-capture.ts";
import { NativeScreenRecorderError } from "../../src/services/native-screen-recorder.ts";
import type {
  NativeScreenRecorder,
  NativeScreenRecording,
} from "../../src/services/native-screen-recorder.ts";

/**
 * A recorder that writes a small footage file where it was asked to and
 * reports what a stopped agent-device recording reports.
 */
const fakeRecorder = (
  options: {
    readonly start?: NativeScreenRecorder["start"];
    readonly stopped?: Partial<NativeScreenRecording>;
    readonly stopFails?: boolean;
    /** Stop says it began here, then waits for `release`. */
    readonly stopGate?: {
      readonly began: Deferred.Deferred<true>;
      readonly release: Deferred.Deferred<true>;
    };
  } = {}
) =>
  Effect.gen(function* makeFakeRecorder() {
    const fileSystem = yield* FileSystem.FileSystem;
    let file: string | undefined;
    const calls: string[] = [];
    const recorder: NativeScreenRecorder = {
      start: (target) =>
        options.start?.(target) ??
        Effect.gen(function* fakeStart() {
          calls.push("start");
          file = target;
          return yield* Clock.currentTimeMillis;
        }),
      stop: () =>
        Effect.gen(function* fakeStop() {
          calls.push("stop");
          if (options.stopGate !== undefined) {
            yield* Deferred.succeed(options.stopGate.began, true);
            yield* Deferred.await(options.stopGate.release);
          }
          if (options.stopFails === true || file === undefined) {
            return yield* Effect.fail(
              new NativeScreenRecorderError({
                message: "The device's screen recorder could not stop.",
              })
            );
          }
          yield* fileSystem
            .writeFile(file, new Uint8Array([0, 0, 0, 8]))
            .pipe(Effect.orDie);
          return {
            capturedDurationMs: undefined,
            devicePath: "retired",
            durationMs: 0,
            files: [file],
            hidden: [],
            recorder: "confirmed",
            warning: undefined,
            ...options.stopped,
          } satisfies NativeScreenRecording;
        }),
    };
    return { calls, recorder };
  });

/** What a device without a screen recorder offers. */
const absentRecorder = Option.getOrUndefined(
  Option.none<NativeScreenRecorder>()
);

const tempDirectory = FileSystem.FileSystem.pipe(
  Effect.flatMap((fileSystem) =>
    fileSystem.makeTempDirectoryScoped({ prefix: "device-video-" })
  ),
  Effect.orDie
);

describe("makeDeviceVideoCapture", () => {
  it.effect(
    "records from begin to end and answers the video's time map once",
    () =>
      Effect.gen(function* recordsCapture() {
        const directory = yield* tempDirectory;
        const { calls, recorder } = yield* fakeRecorder();
        const rendered: string[] = [];
        yield* TestClock.setTime(10_000);
        const capture = yield* makeDeviceVideoCapture({
          directory,
          fastForward: "capped",
          pacing: "condensed",
          platform: "android",
          recorder: () => recorder,
          render: (folder) =>
            Effect.sync(() => {
              rendered.push(folder);
            }),
        });
        expect(capture.live()).toBe(false);
        yield* capture.begin;
        expect(capture.live()).toBe(true);
        yield* TestClock.adjust("2 seconds");
        yield* capture.action(TestClock.adjust("500 millis"));
        yield* TestClock.adjust("4 seconds");
        yield* capture.takeover(14_000);
        const timeMap = yield* capture.end;
        const folder = path.join(directory, DEVICE_VIDEO_DIRECTORY);
        expect(timeMap?.startedAt).toBe(new Date(10_000).toISOString());
        expect(timeMap?.segments.at(-1)?.runToMs).toBe(6500);
        expect(rendered).toEqual([folder]);
        const manifest = yield* readDeviceCapture(folder);
        expect(manifest).toMatchObject({
          actions: [{ fromMs: 2000, toMs: 2500 }],
          endedAt: 16_500,
          files: ["recording.mp4"],
          pacing: "condensed",
          platform: "android",
          startedAt: 10_000,
          state: "recorded",
          takeovers: [{ fromMs: 4000, toMs: 6500 }],
        });
        // A second end stops nothing and answers the same map.
        expect(yield* capture.end).toEqual(timeMap);
        expect(calls).toEqual(["start", "stop"]);
        expect(rendered).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("stays live while Stop finalizes the record", () =>
    Effect.gen(function* liveThroughStop() {
      const directory = yield* tempDirectory;
      const stopGate = {
        began: yield* Deferred.make<true>(),
        release: yield* Deferred.make<true>(),
      };
      const { recorder } = yield* fakeRecorder({ stopGate });
      const capture = yield* makeDeviceVideoCapture({
        directory,
        fastForward: "capped",
        pacing: "real-time",
        platform: "android",
        recorder: () => recorder,
      });
      yield* capture.begin;
      const ending = yield* Effect.forkChild(capture.end);
      yield* Deferred.await(stopGate.began);
      // A status read now must not call the recording interrupted.
      expect(capture.live()).toBe(true);
      yield* Deferred.succeed(stopGate.release, true);
      yield* Fiber.join(ending);
      expect(capture.live()).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("says why a device without a recorder kept no video", () =>
    Effect.gen(function* noRecorder() {
      const directory = yield* tempDirectory;
      const capture = yield* makeDeviceVideoCapture({
        directory,
        fastForward: "capped",
        pacing: "real-time",
        platform: "ios",
        recorder: () => absentRecorder,
      });
      yield* capture.begin;
      expect(capture.live()).toBe(false);
      expect(yield* capture.end).toBeUndefined();
      const manifest = yield* readDeviceCapture(
        path.join(directory, DEVICE_VIDEO_DIRECTORY)
      );
      expect(manifest).toMatchObject({
        reason: "This device offers no screen recorder.",
        state: "not-recorded",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("keeps the session going when the recorder will not start", () =>
    Effect.gen(function* startFails() {
      const directory = yield* tempDirectory;
      const { recorder } = yield* fakeRecorder({
        start: () =>
          Effect.fail(
            new NativeScreenRecorderError({
              message: "The device's screen recorder could not start.",
            })
          ),
      });
      const capture = yield* makeDeviceVideoCapture({
        directory,
        fastForward: "capped",
        pacing: "real-time",
        platform: "android",
        recorder: () => recorder,
      });
      yield* capture.begin;
      expect(capture.live()).toBe(false);
      // Spans after a failed start are not recorded anywhere.
      yield* capture.action(Effect.void);
      expect(yield* capture.end).toBeUndefined();
      expect(
        yield* readDeviceCapture(path.join(directory, DEVICE_VIDEO_DIRECTORY))
      ).toMatchObject({
        actions: [],
        reason: "The device's screen recorder could not start.",
        state: "not-recorded",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("records a failed stop as footage that was not kept", () =>
    Effect.gen(function* stopFails() {
      const directory = yield* tempDirectory;
      const { recorder } = yield* fakeRecorder({ stopFails: true });
      const capture = yield* makeDeviceVideoCapture({
        directory,
        fastForward: "capped",
        pacing: "condensed",
        platform: "ios",
        recorder: () => recorder,
      });
      yield* capture.begin;
      expect(yield* capture.end).toBeUndefined();
      expect(
        yield* readDeviceCapture(path.join(directory, DEVICE_VIDEO_DIRECTORY))
      ).toMatchObject({
        reason: "The device's screen recorder could not stop.",
        state: "failed",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );

  it.effect("records nothing when the session ends before it begins", () =>
    Effect.gen(function* neverBegan() {
      const directory = yield* tempDirectory;
      const { calls, recorder } = yield* fakeRecorder();
      const capture = yield* makeDeviceVideoCapture({
        directory,
        fastForward: "capped",
        pacing: "condensed",
        platform: "android",
        recorder: () => recorder,
      });
      expect(yield* capture.end).toBeUndefined();
      const fileSystem = yield* FileSystem.FileSystem;
      expect(
        yield* fileSystem.exists(
          path.join(directory, DEVICE_VIDEO_DIRECTORY, DEVICE_CAPTURE_FILE)
        )
      ).toBe(false);
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
