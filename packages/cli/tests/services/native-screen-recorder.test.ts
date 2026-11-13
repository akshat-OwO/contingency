import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { TestClock } from "effect/testing";

import {
  deviceFootageBytes,
  footageFiles,
  makeAgentDeviceScreenRecorder,
} from "../../src/services/native-screen-recorder.ts";
import type { ScreenVisibility } from "../../src/services/native-screen-recorder.ts";

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

describe("deviceFootageBytes", () => {
  it("counts only this recording's chunks", () => {
    const listing = [
      "/sdcard/agent-device-recording-900.mp4 7",
      "/sdcard/agent-device-recording-1000.mp4 100",
      "/data/local/tmp/agent-device-recording-1170.mp4 50",
      "/sdcard/agent-device-recording-active.json 3",
      "/sdcard/other-1200.mp4 9",
    ].join("\n");
    expect(deviceFootageBytes(listing, 1000)).toBe(150);
    expect(deviceFootageBytes("", 1000)).toBe(0);
  });
});

describe("makeAgentDeviceScreenRecorder", () => {
  it.effect("measures device footage only while it records", () =>
    Effect.gen(function* deviceFootage() {
      const since: number[] = [];
      const recorder = makeAgentDeviceScreenRecorder({
        deviceFootageBytes: (from) =>
          Effect.sync(() => {
            since.push(from);
            return 42;
          }),
        record: (options) =>
          Promise.resolve(
            options.action === "start"
              ? { recording: "started" }
              : { recording: "stopped" }
          ),
      });
      expect(yield* recorder.footageBytes).toBe(0);
      yield* TestClock.setTime(7000);
      yield* recorder.start("/evidence/video/recording.mp4");
      expect(yield* recorder.footageBytes).toBe(42);
      expect(since).toEqual([7000]);
      yield* recorder.stop();
      expect(yield* recorder.footageBytes).toBe(0);
    })
  );

  it.effect("records hidden spans from the screen's focus while it runs", () =>
    Effect.gen(function* hiddenSpans() {
      const seen = yield* Ref.make<ScreenVisibility>("visible");
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
        visibility: Ref.get(seen),
      });
      yield* TestClock.setTime(5000);
      expect(yield* recorder.start("/evidence/video/recording.mp4")).toBe(5000);
      yield* TestClock.adjust("1 second");
      yield* Ref.set(seen, "secure");
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("1 second");
      yield* Ref.set(seen, "visible");
      yield* TestClock.adjust("1 second");
      yield* Ref.set(seen, "unknown");
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("500 millis");
      const recording = yield* recorder.stop();
      expect(recording).toEqual({
        capturedDurationMs: 4000,
        devicePath: "retired",
        // An answer without a real duration falls back to the wall clock.
        durationMs: 5500,
        files: ["/evidence/video/recording.mp4"],
        // A focus that cannot be read counts as hidden, through Stop.
        hidden: [
          { fromMs: 2000, toMs: 4000 },
          { fromMs: 5000, toMs: 5500 },
        ],
        recorder: "confirmed",
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
