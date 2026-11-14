import { readFileSync } from "node:fs";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { AndroidStreamPacket } from "../../src/services/android-stream-contract.ts";
import {
  makeAndroidStreamRecorder,
  parameterSets,
} from "../../src/services/android-stream-recorder.ts";
import type { AndroidRecorderPacket } from "../../src/services/android-stream.ts";
import { readMp4Frames } from "../../src/services/mp4-frames.ts";

/**
 * A fixture's access units, as the stream worker sends them: Annex B, with a
 * keyframe carrying its SPS and PPS. The fixtures were encoded by x264 with
 * an access unit delimiter before each frame, a keyframe every five frames.
 */
const accessUnits = (name: string) => {
  const bytes = readFileSync(
    path.join(import.meta.dirname, "../fixtures/h264", name)
  );
  const starts: number[] = [];
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (
      bytes[index] === 0 &&
      bytes[index + 1] === 0 &&
      (bytes[index + 2] === 1 ||
        (bytes[index + 2] === 0 && bytes[index + 3] === 1))
    ) {
      starts.push(index);
      index += 2;
    }
  }
  const units: { key: boolean; data: Buffer }[] = [];
  let current: Buffer[] = [];
  let key = false;
  for (const [position, start] of starts.entries()) {
    const unit = bytes.subarray(start, starts[position + 1] ?? bytes.length);
    const header = unit[2] === 1 ? unit[3] : unit[4];
    // oxlint-disable-next-line eslint/no-bitwise -- H.264 NAL unit type.
    const type = (header ?? 0) & 31;
    if (type === 9) {
      if (current.length > 0) {
        units.push({ data: Buffer.concat(current), key });
      }
      current = [];
      key = false;
      continue;
    }
    key ||= type === 5;
    current.push(unit);
  }
  units.push({ data: Buffer.concat(current), key });
  return units;
};

const landscape = accessUnits("landscape.h264");
const portrait = accessUnits("portrait.h264");

/** Frames 100 ms apart from `fromUs`, in the worker's packet shape. */
const frames = (
  units: typeof landscape,
  size: { readonly width: number; readonly height: number },
  fromUs: number
): AndroidStreamPacket[] =>
  units.map((unit, index) => ({
    _tag: "frame",
    data: unit.data.toString("base64"),
    height: size.height,
    key: unit.key,
    timestamp: fromUs + index * 100_000,
    width: size.width,
  }));

const connecting: AndroidStreamPacket = { _tag: "state", state: "connecting" };
const secure: AndroidStreamPacket = { _tag: "state", state: "secure" };
const lost: AndroidStreamPacket = { _tag: "state", state: "lost" };

/** Packets, or `advance` milliseconds of virtual time. */
type Step =
  | { readonly packets: readonly AndroidRecorderPacket[] }
  | { readonly advance: number };

/**
 * A stream that plays `steps` and then holds open, as a live stream does.
 * `drained` settles once the recorder has taken every packet: the stream
 * reaches it only after each packet before it was handled.
 */
const scripted = (
  steps: readonly Step[],
  drained: Deferred.Deferred<true>
): Stream.Stream<AndroidRecorderPacket> =>
  Stream.concat(
    Stream.fromIterable(steps).pipe(
      Stream.flatMap((step) =>
        "packets" in step
          ? Stream.fromIterable(step.packets)
          : Stream.fromEffect(TestClock.adjust(`${step.advance} millis`)).pipe(
              Stream.drain
            )
      )
    ),
    Stream.fromEffect(Deferred.succeed(drained, true)).pipe(
      Stream.drain,
      Stream.concat(Stream.never)
    )
  );

/** Frames as a live stream delivers them, one every 100 ms. */
const live = (packets: readonly AndroidRecorderPacket[]): Step[] =>
  packets.flatMap((packet) => [{ packets: [packet] }, { advance: 100 }]);

const record = (
  steps: readonly Step[],
  fileBytes?: { readonly rotate: number; readonly max: number }
) =>
  Effect.gen(function* recordScript() {
    const fileSystem = yield* FileSystem.FileSystem;
    const folder = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "android-stream-recorder-",
    });
    const drained = yield* Deferred.make<true>();
    const recorder = makeAndroidStreamRecorder({
      fileBytes,
      fileSystem,
      packets: scripted(steps, drained),
    });
    const startedAt = yield* recorder.start(path.join(folder, "recording.mp4"));
    yield* Deferred.await(drained).pipe(Effect.timeout("30 seconds"));
    const recording = yield* recorder.stop();
    return {
      folder,
      names: (yield* fileSystem.readDirectory(folder)).toSorted(),
      recorder,
      recording,
      startedAt,
    };
  });

describe("parameterSets", () => {
  it("finds a keyframe's SPS and PPS and nothing in a delta", () => {
    const key = parameterSets(landscape[0]?.data ?? Buffer.alloc(0));
    expect(key.sps?.[0]).toBe(0x67);
    expect(key.pps?.[0]).toBe(0x68);
    expect(parameterSets(landscape[1]?.data ?? Buffer.alloc(0))).toEqual({
      pps: undefined,
      sps: undefined,
    });
  });
});

describe("makeAndroidStreamRecorder", () => {
  it.effect("muxes the stream's packets into footage that plays", () =>
    Effect.scoped(
      Effect.gen(function* muxStream() {
        const { folder, names, recorder, recording, startedAt } = yield* record(
          [
            { packets: [connecting] },
            { advance: 500 },
            ...live(frames(landscape, { height: 48, width: 64 }, 5_000_000)),
            { advance: 1200 },
          ]
        );
        expect(startedAt).toBe(0);
        // Only the finished file is left; its working folder is gone.
        expect(names).toEqual(["recording-0.mp4"]);
        expect(recording).toEqual({
          capturedDurationMs: 2900,
          devicePath: undefined,
          durationMs: 2900,
          files: [path.join(folder, "recording-0.mp4")],
          hidden: [],
          recorder: "confirmed",
          restarts: [],
          starts: [500],
          warning: undefined,
        });
        const played = yield* readMp4Frames(path.join(folder, names[0] ?? ""));
        expect(played.codec).toBe("avc1");
        expect([played.width, played.height]).toEqual([64, 48]);
        expect(played.frames).toEqual(landscape.map((_, index) => index * 100));
        expect(yield* recorder.footageBytes).toBe(0);
      }).pipe(Effect.provide(NodeServices.layer))
    )
  );

  it.effect(
    "starts a new file at the next keyframe after the display changes shape",
    () =>
      Effect.scoped(
        Effect.gen(function* rotate() {
          const { folder, names, recording } = yield* record([
            { packets: [connecting] },
            ...live(frames(landscape, { height: 48, width: 64 }, 0)),
            { advance: 800 },
            ...live(frames(portrait, { height: 64, width: 48 }, 2_000_000)),
            { advance: 1000 },
          ]);
          expect(names).toEqual(["recording-0.mp4", "recording-1.mp4"]);
          expect(recording.starts).toEqual([0, 2000]);
          // The new file opens as the old one closes: nothing is missing.
          expect(recording.restarts).toEqual([]);
          const second = yield* readMp4Frames(
            path.join(folder, "recording-1.mp4")
          );
          expect([second.width, second.height]).toEqual([48, 64]);
          expect(second.frames).toHaveLength(portrait.length);
        }).pipe(Effect.provide(NodeServices.layer))
      )
  );

  it.effect(
    "keeps footage after a lost stream restarts and marks the time between",
    () =>
      Effect.scoped(
        Effect.gen(function* restart() {
          const { names, recording } = yield* record([
            { packets: [connecting] },
            ...live(
              frames(
                landscape.slice(0, 5),
                { height: 48, width: 64 },
                9_000_000
              )
            ),
            { advance: 500 },
            { packets: [lost] },
            { advance: 3000 },
            { packets: [connecting] },
            // The next worker's clock starts again from zero.
            ...live(frames(landscape, { height: 48, width: 64 }, 0)),
          ]);
          expect(names).toEqual(["recording-0.mp4", "recording-1.mp4"]);
          expect(recording.starts).toEqual([0, 4000]);
          expect(recording.restarts).toEqual([{ fromMs: 1000, toMs: 4000 }]);
          expect(recording.recorder).toBe("confirmed");
        }).pipe(Effect.provide(NodeServices.layer))
      )
  );

  it.effect("holds a secure screen out as a Hidden Interval", () =>
    Effect.scoped(
      Effect.gen(function* hideSecure() {
        const { recording } = yield* record([
          { packets: [connecting] },
          ...live(frames(landscape.slice(0, 5), { height: 48, width: 64 }, 0)),
          { advance: 500 },
          // The worker withholds frames until the screen is visible again.
          { packets: [secure] },
          { advance: 2500 },
          { packets: [connecting] },
          ...live(
            frames(landscape.slice(5), { height: 48, width: 64 }, 3_500_000)
          ),
          { packets: [secure] },
          { advance: 700 },
        ]);
        expect(recording.files).toHaveLength(1);
        expect(recording.hidden).toEqual([
          { fromMs: 1000, toMs: 3500 },
          // Hidden until Stop.
          { fromMs: 4200, toMs: 4900 },
        ]);
      }).pipe(Effect.provide(NodeServices.layer))
    )
  );

  it.effect("reports a lost stream at Stop", () =>
    Effect.scoped(
      Effect.gen(function* lostAtStop() {
        const { recording } = yield* record([
          { packets: [connecting] },
          ...live(frames(landscape, { height: 48, width: 64 }, 0)),
          { packets: [lost] },
          { advance: 800 },
        ]);
        expect(recording.recorder).toBe("lost");
        expect(recording.files).toHaveLength(1);
        expect(recording.capturedDurationMs).toBe(1200);
        expect(recording.durationMs).toBe(2000);
      }).pipe(Effect.provide(NodeServices.layer))
    )
  );

  it.effect(
    "places a file that opens on frames the stream already held before Start",
    () =>
      Effect.scoped(
        Effect.gen(function* joinMidGroup() {
          const { recording } = yield* record([
            { packets: [connecting] },
            // The stream replays the frames since its last keyframe at once.
            {
              packets: frames(landscape, { height: 48, width: 64 }, 7_000_000),
            },
            { advance: 100 },
            ...live(
              frames(
                landscape.slice(5, 6),
                { height: 48, width: 64 },
                8_200_000
              )
            ),
          ]);
          // The file's last frame is 1200 ms after its first, and it arrived
          // 100 ms after Start, so the file's first frame was shown 1100 ms
          // before it.
          expect(recording.starts).toEqual([-1100]);
          expect(recording.restarts).toEqual([]);
        }).pipe(Effect.provide(NodeServices.layer))
      )
  );

  it.effect("keeps a loss until the next stream's footage is kept", () =>
    Effect.scoped(
      Effect.gen(function* reconnectOnly() {
        const { recording } = yield* record([
          { packets: [connecting] },
          ...live(frames(landscape, { height: 48, width: 64 }, 0)),
          { packets: [lost] },
          { advance: 3000 },
          // A new worker says it is connecting, but sends no frame.
          { packets: [connecting] },
          { advance: 1000 },
        ]);
        expect(recording.files).toHaveLength(1);
        expect(recording.recorder).toBe("lost");
      }).pipe(Effect.provide(NodeServices.layer))
    )
  );

  it.effect("marks the frames it fell behind on as a gap", () =>
    Effect.scoped(
      Effect.gen(function* fellBehind() {
        const units = frames(landscape, { height: 48, width: 64 }, 0);
        const { names, recording } = yield* record([
          { packets: [connecting] },
          // Frames 0 to 200 ms, then 300 and 400 ms are missed, and the
          // stream resumes at the 500 ms keyframe.
          ...live(units.slice(0, 3)),
          { packets: [{ _tag: "skipped" }] },
          ...live(units.slice(5)),
        ]);
        expect(names).toEqual(["recording-0.mp4", "recording-1.mp4"]);
        expect(recording.starts).toEqual([0, 500]);
        expect(recording.restarts).toEqual([{ fromMs: 200, toMs: 500 }]);
        expect(recording.recorder).toBe("confirmed");
      }).pipe(Effect.provide(NodeServices.layer))
    )
  );

  it.effect("starts a new file at a keyframe once a file is large", () =>
    Effect.scoped(
      Effect.gen(function* rotateBySize() {
        const { folder, names, recording } = yield* record(
          [
            { packets: [connecting] },
            ...live(frames(landscape, { height: 48, width: 64 }, 0)),
          ],
          { max: 4 * 1024 ** 3, rotate: 1 }
        );
        const keys = landscape.filter((unit) => unit.key).length;
        expect(names).toHaveLength(keys);
        expect(recording.restarts).toEqual([]);
        expect(recording.warning).toBeUndefined();
        let played = 0;
        for (const name of names) {
          played += (yield* readMp4Frames(path.join(folder, name))).frames
            .length;
        }
        expect(played).toBe(landscape.length);
      }).pipe(Effect.provide(NodeServices.layer))
    )
  );

  it.effect("keeps what a file holds when it reaches the byte limit", () =>
    Effect.scoped(
      Effect.gen(function* byteLimit() {
        const steps = [
          { packets: [connecting] },
          ...live(frames(landscape, { height: 48, width: 64 }, 0)),
        ];
        const whole = yield* record(steps);
        const fileSystem = yield* FileSystem.FileSystem;
        const size = Number(
          (yield* fileSystem.stat(whole.recording.files[0] ?? "")).size
        );
        // The writer fails partway through the footage. Its first write
        // carries the header with the first fragment, so it must fit.
        const { folder, names, recording } = yield* record(steps, {
          max: Math.floor(size * 0.85),
          rotate: 4 * 1024 ** 3,
        });
        expect(recording.warning).toContain("byte limit");
        const first = yield* readMp4Frames(path.join(folder, names[0] ?? ""));
        expect(first.frames.length).toBeGreaterThan(0);
        expect(first.frames.length).toBeLessThan(landscape.length);
        expect(recording.starts[0]).toBe(0);
      }).pipe(Effect.provide(NodeServices.layer))
    )
  );

  it.effect("fails a start the stream never makes live", () =>
    Effect.scoped(
      Effect.gen(function* deadStream() {
        const fileSystem = yield* FileSystem.FileSystem;
        const folder = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "android-stream-recorder-",
        });
        const recorder = makeAndroidStreamRecorder({
          fileSystem,
          packets: Stream.make(lost),
        });
        const started = yield* recorder
          .start(path.join(folder, "recording.mp4"))
          .pipe(Effect.flip);
        expect(started.message).toBe(
          "The device stream did not start, so nothing recorded."
        );
        // A failed start leaves nothing running.
        const stopped = yield* recorder.stop().pipe(Effect.flip);
        expect(stopped.message).toBe(
          "The device's screen recorder is not running."
        );
      }).pipe(Effect.provide(NodeServices.layer))
    )
  );
});
