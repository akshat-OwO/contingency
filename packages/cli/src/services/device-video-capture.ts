import path from "node:path";

import { DeviceVideoSpan, RunVideoFastForward } from "@contingency/protocol";
import type { DevicePlatform, RunVideoTimeMap } from "@contingency/protocol";
import type { Result } from "effect";
import {
  Clock,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Schedule,
  Schema,
} from "effect";

import { deviceVideoTimeMap } from "./device-video-plan.ts";
import type { DeviceCaptureFacts } from "./device-video-plan.ts";
import type {
  NativeScreenRecorder,
  NativeScreenRecording,
} from "./native-screen-recorder.ts";

/** The folder, inside a session's evidence directory, that holds its video. */
export const DEVICE_VIDEO_DIRECTORY = "video";
/** What the capture recorded about itself; it outlives the footage. */
export const DEVICE_CAPTURE_FILE = "capture.json";
/** Where the recorder is asked to write. Android chunks land beside it. */
export const DEVICE_RECORDING_FILE = "recording.mp4";
/** The rendered video, once the footage is encoded. */
export const DEVICE_VIDEO_FILE = "video.webm";

/** The encoded size at which the capture warns, as web Teaching does. */
export const DEVICE_VIDEO_BUDGET_BYTES = 500 * 1024 * 1024;
/** The footage size at which video capture ends as incomplete. */
export const DEVICE_VIDEO_HARD_CAP_BYTES = 4 * 1024 * 1024 * 1024;
/** How often local footage is measured while recording. */
const SIZE_CHECK_INTERVAL = "10 seconds";
/** A hung recorder start or stop; agent-device itself waits up to 15 s. */
const RECORDER_TIMEOUT = "90 seconds";

const Spans = Schema.Array(DeviceVideoSpan);

/** The capture's own record, beside its footage. */
// oxlint-disable-next-line eslint/no-redeclare
export const DeviceCaptureManifest = Schema.Struct({
  actions: Spans,
  /** The local footage passed the size budget; capture continued. */
  budgetExceeded: Schema.Boolean,
  capturedDurationMs: Schema.optional(Schema.Finite),
  devicePath: Schema.optional(
    Schema.Literals(["pending", "retirable", "retired"])
  ),
  /** Epoch milliseconds the recorder stopped. */
  endedAt: Schema.NullOr(Schema.Finite),
  fastForward: RunVideoFastForward,
  /** Footage file names inside the video folder, in order. */
  files: Schema.Array(Schema.String),
  hidden: Spans,
  pacing: Schema.Literals(["condensed", "real-time"]),
  platform: Schema.Literals(["android", "ios"]),
  reason: Schema.optional(Schema.String),
  recorder: Schema.optional(
    Schema.Literals(["confirmed", "unconfirmed", "lost"])
  ),
  sizeLimitFromMs: Schema.optional(Schema.Finite),
  /** Epoch milliseconds the recorder reported running: the video's zero. */
  startedAt: Schema.NullOr(Schema.Finite),
  /**
   * `recording` until Stop finalizes it; one left `recording` belongs to a
   * process that ended mid-capture. `failed` recorded but kept no footage.
   */
  state: Schema.Literals(["recording", "recorded", "not-recorded", "failed"]),
  takeovers: Spans,
  version: Schema.Literal(1),
  warning: Schema.optional(Schema.String),
});
export type DeviceCaptureManifest = typeof DeviceCaptureManifest.Type;

const encodeManifest = Schema.encodeSync(
  Schema.fromJsonString(DeviceCaptureManifest)
);
const decodeManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DeviceCaptureManifest)
);

/** Read a capture's record, or nothing when it has none or it is unreadable. */
export const readDeviceCapture = (folder: string) =>
  Effect.gen(function* readCapture() {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem
      .readFileString(path.join(folder, DEVICE_CAPTURE_FILE))
      .pipe(Effect.option);
    if (Option.isNone(contents)) {
      return;
    }
    const decoded = yield* decodeManifest(contents.value).pipe(Effect.option);
    return Option.getOrUndefined(decoded);
  });

const captureNote = (manifest: DeviceCaptureManifest): string | undefined => {
  const notes = [
    manifest.recorder === "lost"
      ? "The device's recorder was lost before Stop; footage after its last frame is unproven."
      : undefined,
    manifest.recorder === "unconfirmed"
      ? "The device's recorder did not confirm it stopped cleanly; footage after its last frame is unproven."
      : undefined,
    manifest.sizeLimitFromMs === undefined
      ? undefined
      : "Video capture ended at its size limit; the session continued without video.",
    manifest.budgetExceeded && manifest.sizeLimitFromMs === undefined
      ? "The footage passed its 500 MB budget."
      : undefined,
    manifest.devicePath === "pending" || manifest.devicePath === "retirable"
      ? "A copy of the recording may remain on the device until agent-device retires it."
      : undefined,
  ].filter((note) => note !== undefined);
  return notes.length === 0 ? undefined : notes.join(" ");
};

/** The facts a recorded capture gives its video plan. */
export const captureFacts = (
  manifest: DeviceCaptureManifest
): DeviceCaptureFacts | undefined =>
  manifest.startedAt === null || manifest.endedAt === null
    ? undefined
    : {
        actions: manifest.actions,
        durationMs: Math.max(0, manifest.endedAt - manifest.startedAt),
        fastForward: manifest.fastForward,
        hidden: manifest.hidden,
        note: captureNote(manifest),
        pacing: manifest.pacing,
        recorder: manifest.recorder,
        sizeLimitFromMs: manifest.sizeLimitFromMs,
        startedAt: manifest.startedAt,
        stoppedEarly:
          manifest.warning !== undefined &&
          /stopped before record stop/iu.test(manifest.warning),
        takeovers: manifest.takeovers,
      };

/** One session's device video capture, from Start to Stop. */
export interface DeviceVideoCaptureSession {
  /**
   * Start the device's recorder. Never fails the session: a recorder that
   * cannot start leaves a record saying why, and keyframes continue.
   */
  readonly begin: Effect.Effect<void>;
  /**
   * Stop the recorder and finalize the capture's record. Returns the video's
   * time map when footage was kept. A second call does nothing.
   */
  readonly end: Effect.Effect<RunVideoTimeMap | undefined>;
  /** Run `effect` as one agent action, so the video plays it in real time. */
  readonly action: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  /** The user held the device from `fromMs` (epoch) until now. */
  readonly takeover: (fromEpochMs: number) => Effect.Effect<void>;
  /**
   * This process still owns an unfinished capture: from `begin` until `end`
   * has finalized its record, so a status read while Stop is finishing is
   * not mistaken for an interrupted recording.
   */
  readonly live: () => boolean;
}

/**
 * A session's device video, recorded through the device's own screen
 * recorder into `directory/video` ([ADR 0079](../../../../docs/adr/0079-native-recordings-use-agent-device-screen-recording.md)).
 * Footage stays inside the session's evidence directory, so Cleanup that
 * deletes the directory deletes the video with it.
 */
export const makeDeviceVideoCapture = (input: {
  readonly directory: string;
  readonly platform: DevicePlatform;
  readonly pacing: "condensed" | "real-time";
  readonly fastForward: RunVideoFastForward;
  readonly recorder: () => NativeScreenRecorder | undefined;
  /** Render the footage once the capture is finalized. */
  readonly render?: (folder: string) => Effect.Effect<void>;
}): Effect.Effect<DeviceVideoCaptureSession, never, FileSystem.FileSystem> =>
  Effect.gen(function* deviceVideoCapture() {
    const fileSystem = yield* FileSystem.FileSystem;
    const folder = path.join(input.directory, DEVICE_VIDEO_DIRECTORY);
    let manifest: DeviceCaptureManifest | undefined;
    let recorder: NativeScreenRecorder | undefined;
    let monitor: Fiber.Fiber<unknown> | undefined;
    /** Set once the capture ends: the time map `end` answers from then on. */
    let ended: { readonly timeMap: RunVideoTimeMap | undefined } | undefined;
    /** A recorder stopped at the size limit, before the session's Stop. */
    let capped:
      | {
          readonly stopped: Result.Result<
            NativeScreenRecording,
            { readonly message: string }
          >;
          readonly at: number;
        }
      | undefined;

    const save = (next: DeviceCaptureManifest) =>
      Effect.gen(function* saveCapture() {
        manifest = next;
        const file = path.join(folder, DEVICE_CAPTURE_FILE);
        yield* fileSystem.writeFileString(`${file}.tmp`, encodeManifest(next), {
          mode: 0o600,
        });
        yield* fileSystem.rename(`${file}.tmp`, file);
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(
            `Could not save the device video record: ${cause.message}`
          )
        ),
        Effect.ignore
      );
    const update = (
      change: (current: DeviceCaptureManifest) => DeviceCaptureManifest
    ) =>
      Effect.suspend(() =>
        manifest === undefined ? Effect.void : save(change(manifest))
      );
    const offset = (epochMs: number) =>
      manifest?.startedAt === null || manifest === undefined
        ? 0
        : Math.max(0, epochMs - manifest.startedAt);
    const footageBytes = Effect.gen(function* measureFootage() {
      const names = yield* fileSystem
        .readDirectory(folder)
        .pipe(Effect.orElseSucceed(() => []));
      let total = 0;
      for (const name of names) {
        if (!name.endsWith(".mp4")) {
          continue;
        }
        const info = yield* fileSystem
          .stat(path.join(folder, name))
          .pipe(Effect.option);
        if (Option.isSome(info)) {
          total += Number(info.value.size);
        }
      }
      return total;
    });

    const collect = (recording: NativeScreenRecording, stoppedAt: number) =>
      Effect.gen(function* collectFootage() {
        // Keep footage in order until the hard cap; drop the rest.
        const files: string[] = [];
        let total = 0;
        let sizeLimitFromMs = manifest?.sizeLimitFromMs;
        for (const [index, file] of recording.files.entries()) {
          const info = yield* fileSystem.stat(file).pipe(Effect.option);
          if (Option.isNone(info)) {
            continue;
          }
          const bytes = Number(info.value.size);
          if (total + bytes > DEVICE_VIDEO_HARD_CAP_BYTES) {
            sizeLimitFromMs ??= Math.min(
              offset(stoppedAt),
              index === 0 ? 0 : index * 180_000
            );
            yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
            continue;
          }
          total += bytes;
          files.push(path.basename(file));
        }
        return { files, sizeLimitFromMs, total };
      });

    const stopRecorder = (active: NativeScreenRecorder) =>
      active.stop().pipe(
        Effect.timeoutOrElse({
          duration: RECORDER_TIMEOUT,
          orElse: () =>
            Effect.fail({
              message: "The device's screen recorder did not stop in time.",
            }),
        }),
        Effect.result
      );

    const begin = Effect.gen(function* beginCapture() {
      if (manifest !== undefined) {
        return;
      }
      const active = input.recorder();
      const initial: DeviceCaptureManifest = {
        actions: [],
        budgetExceeded: false,
        endedAt: null,
        fastForward: input.fastForward,
        files: [],
        hidden: [],
        pacing: input.pacing,
        platform: input.platform,
        startedAt: null,
        state: "recording",
        takeovers: [],
        version: 1,
      };
      const made = yield* fileSystem
        .makeDirectory(folder, { mode: 0o700, recursive: true })
        .pipe(Effect.result);
      if (made._tag === "Failure") {
        yield* Effect.logWarning(
          `Could not prepare the device video folder: ${made.failure.message}`
        );
        return;
      }
      if (active === undefined) {
        yield* save({
          ...initial,
          reason: "This device offers no screen recorder.",
          state: "not-recorded",
        });
        return;
      }
      yield* save(initial);
      const started = yield* active
        .start(path.join(folder, DEVICE_RECORDING_FILE))
        .pipe(
          Effect.timeoutOrElse({
            duration: RECORDER_TIMEOUT,
            orElse: () =>
              Effect.fail({
                message: "The device's screen recorder did not start in time.",
              }),
          }),
          Effect.result
        );
      if (started._tag === "Failure") {
        yield* update((current) => ({
          ...current,
          reason: started.failure.message,
          state: "not-recorded",
        }));
        return;
      }
      recorder = active;
      yield* update((current) => ({ ...current, startedAt: started.success }));
      // Android keeps its chunks on the device until Stop, so the cap counts
      // what the recorder holds there as well as this folder.
      const measured = Effect.all([footageBytes, active.footageBytes]).pipe(
        Effect.map(([local, remote]) => local + remote)
      );
      monitor = yield* measured.pipe(
        Effect.flatMap((bytes) =>
          Effect.gen(function* checkFootageSize() {
            if (
              bytes > DEVICE_VIDEO_BUDGET_BYTES &&
              !manifest?.budgetExceeded
            ) {
              yield* update((current) => ({
                ...current,
                budgetExceeded: true,
              }));
            }
            const running = recorder;
            if (bytes > DEVICE_VIDEO_HARD_CAP_BYTES && running !== undefined) {
              // The cap ends video capture, never the session. A Stop that
              // arrives meanwhile waits for this one rather than cutting it.
              yield* Effect.uninterruptible(
                Effect.gen(function* stopAtCap() {
                  const at = yield* Clock.currentTimeMillis;
                  yield* update((current) => ({
                    ...current,
                    sizeLimitFromMs: offset(at),
                  }));
                  capped = { at, stopped: yield* stopRecorder(running) };
                })
              );
            }
          })
        ),
        Effect.repeat({
          schedule: Schedule.spaced(SIZE_CHECK_INTERVAL),
          until: () => manifest?.sizeLimitFromMs !== undefined,
        }),
        Effect.forkDetach
      );
    });

    const end = Effect.gen(function* endCapture() {
      if (ended !== undefined) {
        return ended.timeMap;
      }
      // The session ends now. Waiting for a cap stop already under way, and
      // pulling and finalizing footage, take no part of its time.
      const stoppedAt = yield* Clock.currentTimeMillis;
      if (monitor !== undefined) {
        yield* Fiber.interrupt(monitor);
        monitor = undefined;
      }
      const current = manifest;
      const active = recorder;
      recorder = undefined;
      if (
        current === undefined ||
        current.state !== "recording" ||
        active === undefined
      ) {
        ended = { timeMap: undefined };
        return;
      }
      const stopped = capped?.stopped ?? (yield* stopRecorder(active));
      if (stopped._tag === "Failure") {
        yield* update((value) => ({
          ...value,
          endedAt: stoppedAt,
          reason: stopped.failure.message,
          state: "failed",
        }));
        ended = { timeMap: undefined };
        return;
      }
      const recording = stopped.success;
      const collected = yield* collect(recording, stoppedAt);
      if (collected.files.length === 0) {
        yield* update((value) => ({
          ...value,
          endedAt: stoppedAt,
          reason: "The device's screen recorder kept no footage.",
          state: "failed",
        }));
        ended = { timeMap: undefined };
        return;
      }
      const footage = yield* footageBytes;
      const finalized: DeviceCaptureManifest = {
        ...current,
        ...manifest,
        budgetExceeded:
          (manifest?.budgetExceeded ?? false) ||
          footage > DEVICE_VIDEO_BUDGET_BYTES,
        capturedDurationMs: recording.capturedDurationMs,
        devicePath: recording.devicePath,
        endedAt: stoppedAt,
        files: collected.files,
        hidden: recording.hidden,
        recorder: recording.recorder,
        sizeLimitFromMs: collected.sizeLimitFromMs,
        state: "recorded",
        warning: recording.warning,
      };
      yield* save(finalized);
      const facts = captureFacts(finalized);
      const timeMap =
        facts === undefined ? undefined : deviceVideoTimeMap(facts);
      ended = { timeMap };
      if (input.render !== undefined) {
        yield* input.render(folder);
      }
      return timeMap;
    });

    const span = (
      key: "actions" | "takeovers",
      fromEpochMs: number,
      toEpochMs: number
    ) =>
      Effect.suspend(() => {
        if (recorder === undefined || manifest?.startedAt === null) {
          return Effect.void;
        }
        const entry = { fromMs: offset(fromEpochMs), toMs: offset(toEpochMs) };
        return update((value) => ({ ...value, [key]: [...value[key], entry] }));
      });

    return {
      action: (effect) =>
        Effect.gen(function* markAction() {
          const from = yield* Clock.currentTimeMillis;
          return yield* effect.pipe(
            Effect.ensuring(
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((to) => span("actions", from, to))
              )
            )
          );
        }),
      begin,
      end,
      live: () => manifest?.state === "recording" && ended === undefined,
      takeover: (fromEpochMs) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((to) => span("takeovers", fromEpochMs, to))
        ),
    } satisfies DeviceVideoCaptureSession;
  });
