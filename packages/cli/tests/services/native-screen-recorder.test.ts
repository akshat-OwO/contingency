import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import {
  footageFiles,
  makeAgentDeviceScreenRecorder,
} from "../../src/services/native-screen-recorder.ts";

describe("footageFiles", () => {
  it("orders chunks and keeps only files in the requested folder", () => {
    expect(
      footageFiles("/evidence/video/recording.mp4", {
        chunks: [
          { index: 1, path: "/evidence/video/recording-1.mp4" },
          { index: 0, path: "recording.mp4" },
          { index: 2, path: "/elsewhere/recording-2.mp4" },
        ],
      })
    ).toEqual([
      "/evidence/video/recording.mp4",
      "/evidence/video/recording-1.mp4",
    ]);
    expect(footageFiles("/evidence/video/recording.mp4", {})).toEqual([
      "/evidence/video/recording.mp4",
    ]);
  });
});

describe("makeAgentDeviceScreenRecorder", () => {
  it.effect("reads the recorder's own answer at Stop", () =>
    Effect.gen(function* stopAnswer() {
      const requests: unknown[] = [];
      const recorder = makeAgentDeviceScreenRecorder({
        record: (options) => {
          requests.push({ action: options.action, path: options.path });
          return Promise.resolve(
            options.action === "start"
              ? { recording: "started" }
              : {
                  capturedDurationMs: 4000,
                  durationMs: -1,
                  nativePathDisposition: "retired",
                  outPath: "/evidence/video/recording.mp4",
                  recorder: "confirmed",
                  recording: "stopped",
                  warning: "",
                }
          );
        },
      });
      yield* TestClock.setTime(5000);
      expect(yield* recorder.start("/evidence/video/recording.mp4")).toBe(5000);
      expect(yield* recorder.footageBytes).toBe(0);
      yield* TestClock.adjust("5500 millis");
      const recording = yield* recorder.stop();
      expect(recording).toEqual({
        capturedDurationMs: 4000,
        devicePath: "retired",
        // An answer without a real duration falls back to the wall clock.
        durationMs: 5500,
        files: ["/evidence/video/recording.mp4"],
        hidden: [],
        recorder: "confirmed",
        restarts: [],
        starts: [0],
        warning: undefined,
      });
      expect(requests).toEqual([
        { action: "start", path: "/evidence/video/recording.mp4" },
        { action: "stop", path: undefined },
      ]);
    })
  );

  it.effect("fails a start the recorder does not confirm", () =>
    Effect.gen(function* unconfirmedStart() {
      const recorder = makeAgentDeviceScreenRecorder({
        record: () => Promise.resolve({ recording: "idle" }),
      });
      const error = yield* Effect.flip(recorder.start("/video/recording.mp4"));
      expect(error.message).toBe(
        "The device's screen recorder did not report starting."
      );
    })
  );

  it.effect("fails on an answer it cannot read", () =>
    Effect.gen(function* unreadable() {
      const recorder = makeAgentDeviceScreenRecorder({
        // An agent-device answer of another shape, as a future version might send.
        record: () => Promise.resolve(JSON.parse('{"chunks":"many"}')),
      });
      const error = yield* Effect.flip(recorder.start("/video/recording.mp4"));
      expect(error.message).toContain("could not be read");
    })
  );

  it.effect("fails a stop with nothing recording", () =>
    Effect.gen(function* notRunning() {
      const recorder = makeAgentDeviceScreenRecorder({
        record: () => Promise.resolve({ recording: "stopped" }),
      });
      const error = yield* Effect.flip(recorder.stop());
      expect(error.message).toBe(
        "The device's screen recorder is not running."
      );
    })
  );
});
