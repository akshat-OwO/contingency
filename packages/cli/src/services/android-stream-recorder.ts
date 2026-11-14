import path from "node:path";

import type { DeviceVideoSpan } from "@contingency/protocol";
import type { FileSystem } from "effect";
import { Clock, Deferred, Effect, Fiber, Stream } from "effect";
import { ScreenRecording } from "expo-device-hub/vendor/serve-emu/dist/screen-recording.js";

import type { AndroidStreamPacket } from "./android-stream-contract.ts";
import { NativeScreenRecorderError } from "./native-screen-recorder.ts";
import type {
  NativeScreenRecorder,
  NativeScreenRecording,
} from "./native-screen-recorder.ts";

/** The hub writes each generation under this name in its own folder. */
const HUB_PARTIAL = "recording.mp4.partial";
const HUB_FINISHED = "recording.mp4";
/** The packets' source, for the hub. Any value but its gRPC screenshot one. */
const PACKET_SOURCE = "contingency-stream";
/** The hub's longest generation. Each one is rotated well before it. */
const MAX_FILE_DURATION_MS = 86_400_000;

/** The SPS and PPS NAL units of an Annex B access unit, when it has them. */
export const parameterSets = (data: Uint8Array) => {
  let sps: Buffer | undefined;
  let pps: Buffer | undefined;
  const starts: { readonly start: number; readonly payload: number }[] = [];
  for (let index = 0; index + 3 <= data.length; index += 1) {
    if (data[index] !== 0 || data[index + 1] !== 0) {
      continue;
    }
    let length = 0;
    if (data[index + 2] === 1) {
      length = 3;
    } else if (data[index + 2] === 0 && data[index + 3] === 1) {
      length = 4;
    }
    if (length === 0) {
      continue;
    }
    starts.push({ payload: index + length, start: index });
    index += length - 1;
  }
  for (const [position, start] of starts.entries()) {
    const unit = data.subarray(
      start.payload,
      starts[position + 1]?.start ?? data.length
    );
    // oxlint-disable-next-line eslint/no-bitwise -- H.264 NAL unit type.
    const type = (unit[0] ?? 0) & 31;
    if (type === 7) {
      sps = Buffer.from(unit);
    } else if (type === 8) {
      pps = Buffer.from(unit);
    }
  }
  return { pps, sps };
};

/** One footage file being written. */
interface OpenFile {
  readonly index: number;
  readonly directory: string;
  readonly recording: ScreenRecording;
  readonly width: number;
  readonly height: number;
  readonly sps: Buffer;
  readonly pps: Buffer;
  /** The file's first timestamp: its own zero. */
  firstPts: bigint | undefined;
  lastPts: bigint;
  /** When, from the recorder's start, the last frame arrived. */
  lastAt: number;
}

/** One footage file that was finished. */
interface FinishedFile {
  readonly file: string;
  readonly startMs: number;
  readonly endMs: number;
}

interface ActiveRecording {
  readonly folder: string;
  readonly base: string;
  readonly ready: Deferred.Deferred<number, NativeScreenRecorderError>;
  readonly hidden: DeviceVideoSpan[];
  readonly finished: FinishedFile[];
  startedAt: number | undefined;
  hiddenFrom: number | undefined;
  current: OpenFile | undefined;
  next: number;
  /** The stream was lost and no frame has arrived since. */
  lost: boolean;
  warning: string | undefined;
  consumer: Fiber.Fiber<unknown> | undefined;
}

const failure = (message: string) => new NativeScreenRecorderError({ message });

/** Milliseconds from the recording's start; zero before it has one. */
const offset = (recording: ActiveRecording, at: number) =>
  Math.max(0, at - (recording.startedAt ?? at));

/**
 * Whether a frame belongs in the open file. A file holds one display size,
 * one codec configuration, and increasing timestamps; the hub fails a file
 * that changes any of them, so the frame starts the next file instead.
 */
const continuesFile = (
  open: OpenFile,
  frame: { readonly width: number; readonly height: number },
  pts: bigint,
  sets: { readonly sps?: Buffer | undefined; readonly pps?: Buffer | undefined }
) =>
  open.recording.active &&
  open.width === frame.width &&
  open.height === frame.height &&
  pts > open.lastPts &&
  (sets.sps === undefined || sets.sps.equals(open.sps)) &&
  (sets.pps === undefined || sets.pps.equals(open.pps));

/**
 * A screen recorder over the session's live display stream
 * ([ADR 0080](../../../../docs/adr/0080-android-recordings-mux-the-live-display-stream.md)).
 * The stream's H.264 packets are muxed into fragmented MP4 by the pinned
 * hub's `ScreenRecording` and never encoded again, so recording adds no work
 * on the device. The worker drops frames while a secure or unknown window has
 * focus, so footage never holds them; a secure window's span becomes a Hidden
 * Interval. A display size change, a codec change, or a restarted stream ends
 * one file and starts the next at the following keyframe, and the time
 * between files is a gap.
 */
export const makeAndroidStreamRecorder = (input: {
  readonly packets: Stream.Stream<AndroidStreamPacket>;
  readonly fileSystem: FileSystem.FileSystem;
}): NativeScreenRecorder => {
  const { fileSystem } = input;
  let active: ActiveRecording | undefined;

  const removeFolder = (directory: string) =>
    fileSystem
      .remove(directory, { force: true, recursive: true })
      .pipe(Effect.ignore);

  /** Ends the open file and keeps it when the hub finalized it. */
  const closeFile = (recording: ActiveRecording) =>
    Effect.uninterruptible(
      Effect.gen(function* closeOpenFile() {
        const open = recording.current;
        if (open === undefined) {
          return;
        }
        recording.current = undefined;
        const endMs = offset(recording, yield* Clock.currentTimeMillis);
        // Placed by its own timestamps, so frames the stream already held
        // when the file opened sit where they were shown. Before the
        // recorder's start, the file shows the screen as it already was.
        const startMs =
          open.lastAt -
          Number((open.lastPts - (open.firstPts ?? open.lastPts)) / 1000n);
        const finished = yield* Effect.tryPromise({
          catch: (cause) =>
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "The recording could not be finalized.",
          try: () => open.recording.finish(),
        }).pipe(
          Effect.andThen(() => {
            const file = path.join(
              recording.folder,
              `${recording.base}-${open.index}.mp4`
            );
            return fileSystem
              .rename(path.join(open.directory, HUB_FINISHED), file)
              .pipe(
                Effect.mapError((cause) => cause.message),
                Effect.as(file)
              );
          }),
          Effect.result
        );
        yield* removeFolder(open.directory);
        if (finished._tag === "Failure") {
          recording.warning ??= `Part of the recording could not be kept: ${finished.failure}`;
          return;
        }
        recording.finished.push({
          endMs: Math.max(startMs, endMs),
          file: finished.success,
          startMs,
        });
      })
    );

  /** Starts a file at a keyframe, or leaves the frame unrecorded. */
  const openFile = (
    recording: ActiveRecording,
    frame: { readonly width: number; readonly height: number },
    sets: { readonly sps: Buffer; readonly pps: Buffer }
  ) =>
    Effect.gen(function* openNextFile() {
      const index = recording.next;
      recording.next += 1;
      const directory = path.join(
        recording.folder,
        `.${recording.base}-${index}`
      );
      const clock = yield* Clock.Clock;
      const created = yield* Effect.tryPromise({
        catch: (cause) =>
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "The recording file could not be created.",
        try: () =>
          ScreenRecording.create({
            clock: {
              epochMs: () => clock.currentTimeMillisUnsafe(),
              monotonicUs: () => clock.currentTimeNanosUnsafe() / 1000n,
            },
            directory,
            maxDurationMs: MAX_FILE_DURATION_MS,
          }),
      }).pipe(Effect.result);
      if (created._tag === "Failure") {
        recording.warning ??= `Part of the recording could not be kept: ${created.failure}`;
        yield* removeFolder(directory);
        return;
      }
      const open: OpenFile = {
        directory,
        firstPts: undefined,
        height: frame.height,
        index,
        lastAt: 0,
        lastPts: -1n,
        pps: sets.pps,
        recording: created.success,
        sps: sets.sps,
        width: frame.width,
      };
      recording.current = open;
      return open;
    });

  const observeHidden = (recording: ActiveRecording, secure: boolean) =>
    Effect.gen(function* observeHiddenState() {
      const at = offset(recording, yield* Clock.currentTimeMillis);
      if (secure) {
        recording.hiddenFrom ??= at;
      } else if (recording.hiddenFrom !== undefined) {
        recording.hidden.push({
          fromMs: recording.hiddenFrom,
          toMs: Math.max(recording.hiddenFrom, at),
        });
        recording.hiddenFrom = undefined;
      }
    });

  const receiveState = (
    recording: ActiveRecording,
    state: Extract<AndroidStreamPacket, { readonly _tag: "state" }>["state"]
  ) =>
    Effect.gen(function* receiveStatePacket() {
      if (state === "lost") {
        // The next worker's clock starts over, so its frames start a file.
        recording.lost = true;
        yield* closeFile(recording);
        return;
      }
      recording.lost = false;
      yield* observeHidden(recording, state === "secure");
    });

  const receiveFrame = (
    recording: ActiveRecording,
    frame: Extract<AndroidStreamPacket, { readonly _tag: "frame" }>
  ) =>
    Effect.gen(function* receiveFramePacket() {
      recording.lost = false;
      const data = Buffer.from(frame.data, "base64");
      const pts = BigInt(Math.trunc(frame.timestamp));
      const sets = frame.key
        ? parameterSets(data)
        : { pps: undefined, sps: undefined };
      const open = recording.current;
      if (open !== undefined && !continuesFile(open, frame, pts, sets)) {
        yield* closeFile(recording);
      }
      let target = recording.current;
      if (target === undefined) {
        if (sets.sps === undefined || sets.pps === undefined) {
          return;
        }
        target = yield* openFile(recording, frame, {
          pps: sets.pps,
          sps: sets.sps,
        });
        if (target === undefined) {
          return;
        }
      }
      target.recording.accept(
        { data, isConfig: false, isKey: frame.key, pts, type: "frame" },
        { height: frame.height, width: frame.width },
        PACKET_SOURCE
      );
      target.firstPts ??= pts;
      target.lastPts = pts;
      target.lastAt = offset(recording, yield* Clock.currentTimeMillis);
    });

  const receive = (recording: ActiveRecording, packet: AndroidStreamPacket) =>
    Effect.gen(function* receivePacket() {
      if (recording.startedAt === undefined) {
        if (packet._tag === "state" && packet.state === "lost") {
          yield* Deferred.fail(
            recording.ready,
            failure("The device stream did not start, so nothing recorded.")
          );
          return;
        }
        recording.startedAt = yield* Clock.currentTimeMillis;
        yield* Deferred.succeed(recording.ready, recording.startedAt);
      }
      yield* packet._tag === "state"
        ? receiveState(recording, packet.state)
        : receiveFrame(recording, packet);
    });

  const release = (recording: ActiveRecording) =>
    Effect.gen(function* releaseRecording() {
      if (active === recording) {
        active = undefined;
      }
      if (recording.consumer !== undefined) {
        yield* Fiber.interrupt(recording.consumer);
      }
    });

  return {
    footageBytes: Effect.suspend(() => {
      const open = active?.current;
      if (open === undefined) {
        return Effect.succeed(0);
      }
      return fileSystem.stat(path.join(open.directory, HUB_PARTIAL)).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => 0)
      );
    }),
    start: (file) =>
      Effect.gen(function* startRecording() {
        if (active !== undefined) {
          return yield* Effect.fail(
            failure("The device's screen recorder is already running.")
          );
        }
        const recording: ActiveRecording = {
          base: path.basename(file, path.extname(file)),
          consumer: undefined,
          current: undefined,
          finished: [],
          folder: path.dirname(path.resolve(file)),
          hidden: [],
          hiddenFrom: undefined,
          lost: false,
          next: 0,
          ready: yield* Deferred.make<number, NativeScreenRecorderError>(),
          startedAt: undefined,
          warning: undefined,
        };
        active = recording;
        // Each packet is handled whole, so Stop never interrupts a file
        // while it is created or finished.
        recording.consumer = yield* Stream.runForEach(input.packets, (packet) =>
          Effect.uninterruptible(receive(recording, packet))
        ).pipe(
          Effect.ensuring(
            Deferred.fail(
              recording.ready,
              failure("The device stream ended before it showed the screen.")
            )
          ),
          Effect.forkDetach
        );
        return yield* Deferred.await(recording.ready).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Success" ? Effect.void : release(recording)
          )
        );
      }),
    stop: () =>
      Effect.gen(function* stopRecording() {
        const recording = active;
        if (recording === undefined) {
          return yield* Effect.fail(
            failure("The device's screen recorder is not running.")
          );
        }
        yield* release(recording);
        const stoppedAt = yield* Clock.currentTimeMillis;
        yield* closeFile(recording);
        yield* observeHidden(recording, false);
        const files = recording.finished;
        const restarts: DeviceVideoSpan[] = [];
        for (const [index, finished] of files.entries()) {
          const previous = files[index - 1];
          if (previous !== undefined && finished.startMs > previous.endMs) {
            restarts.push({ fromMs: previous.endMs, toMs: finished.startMs });
          }
        }
        return {
          capturedDurationMs: files.at(-1)?.endMs,
          devicePath: undefined,
          durationMs: offset(recording, stoppedAt),
          files: files.map((finished) => finished.file),
          hidden: recording.hidden,
          recorder: recording.lost ? "lost" : "confirmed",
          restarts,
          starts: files.map((finished) => finished.startMs),
          warning: recording.warning,
        } satisfies NativeScreenRecording;
      }),
  };
};
