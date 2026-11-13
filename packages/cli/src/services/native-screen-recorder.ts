import path from "node:path";

import type { DeviceVideoSpan } from "@contingency/protocol";
import { Clock, Data, Effect, Fiber, Schedule, Schema } from "effect";

/** A recorder that would not start or stop, said in a sentence a person can act on. */
export class NativeScreenRecorderError extends Data.TaggedError(
  "NativeScreenRecorderError"
)<{
  readonly message: string;
}> {}

/** What a device's screen recorder left once it stopped. */
export interface NativeScreenRecording {
  /** The footage files, in order. More than one when Android chunked. */
  readonly files: readonly string[];
  /** Wall-clock milliseconds the recorder ran for. */
  readonly durationMs: number;
  /**
   * Milliseconds the footage covers. Android encodes a frame only when the
   * screen changes, so a still ending is not in the file.
   */
  readonly capturedDurationMs: number | undefined;
  /**
   * What the recorder itself was seen doing when it stopped: `confirmed` is
   * the ordinary answer; `unconfirmed` and `lost` mean the footage was served
   * without proof the recorder ended where it should have.
   */
  readonly recorder: "confirmed" | "unconfirmed" | "lost" | undefined;
  /**
   * Whether the recorder's own copy on the device is gone: `retired` once
   * removed, `retirable` or `pending` while a copy may remain there.
   */
  readonly devicePath: "pending" | "retirable" | "retired" | undefined;
  /** What the recorder warned about, such as an early stop at a time limit. */
  readonly warning: string | undefined;
  /**
   * Hidden Intervals: spans, from the recorder's start, when a secure screen
   * or one that could not be classified had focus.
   */
  readonly hidden: readonly DeviceVideoSpan[];
}

/**
 * A device's own screen recorder ([ADR 0079](../../../../docs/adr/0079-native-recordings-use-agent-device-screen-recording.md)).
 * It records the whole screen, touches hidden, into a file this process owns.
 */
export interface NativeScreenRecorder {
  /**
   * Start recording into `file`. Succeeds once the recorder reports that it
   * is running, with the moment, in epoch milliseconds, that it said so.
   */
  readonly start: (
    file: string
  ) => Effect.Effect<number, NativeScreenRecorderError>;
  /** Stop the recorder and collect its footage. */
  readonly stop: () => Effect.Effect<
    NativeScreenRecording,
    NativeScreenRecorderError
  >;
}

const duration = Schema.optional(Schema.Number);

/** A duration agent-device reported, when it is one. */
const elapsed = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/**
 * The subset of agent-device's `record` answer the recorder reads. An answer
 * of another shape fails the call; a duration that is not a time reads as
 * absent.
 */
// oxlint-disable-next-line eslint/no-redeclare
export const AgentDeviceRecordResult = Schema.Struct({
  capturedDurationMs: duration,
  chunks: Schema.optional(
    Schema.Array(Schema.Struct({ index: Schema.Finite, path: Schema.String }))
  ),
  durationMs: duration,
  nativePathDisposition: Schema.optional(Schema.String),
  outPath: Schema.optional(Schema.String),
  recorder: Schema.optional(Schema.String),
  recording: Schema.optional(Schema.String),
  warning: Schema.optional(Schema.String),
});
export type AgentDeviceRecordResult = typeof AgentDeviceRecordResult.Type;
const decodeRecordResult = Schema.decodeUnknownEffect(AgentDeviceRecordResult);

/** A device's focus as a recording sees it. */
export type ScreenVisibility = "visible" | "secure" | "unknown";

const recorderState = (
  value: string | undefined
): NativeScreenRecording["recorder"] =>
  value === "confirmed" || value === "unconfirmed" || value === "lost"
    ? value
    : undefined;

const devicePathState = (
  value: string | undefined
): NativeScreenRecording["devicePath"] =>
  value === "pending" || value === "retirable" || value === "retired"
    ? value
    : undefined;

/** The footage files a stop names, in order, inside the recording's folder. */
export const footageFiles = (
  requested: string,
  result: AgentDeviceRecordResult
): readonly string[] => {
  const chunks = (result.chunks ?? [])
    .toSorted((left, right) => left.index - right.index)
    .map((chunk) => chunk.path);
  const files = chunks.length > 0 ? chunks : [result.outPath ?? requested];
  const folder = path.dirname(path.resolve(requested));
  // Footage is read only from where it was asked to go; anything else the
  // recorder names is not this recording's.
  return files.flatMap((file) => {
    const resolved = path.resolve(folder, file);
    return path.dirname(resolved) === folder ? [resolved] : [];
  });
};

interface ActiveRecording {
  readonly file: string;
  readonly startedAt: number;
  readonly hidden: DeviceVideoSpan[];
  hiddenFrom: number | undefined;
  monitor: Fiber.Fiber<unknown> | undefined;
}

/** Folds one focus reading into the recording's Hidden Intervals. */
const observeFocus = (
  recording: ActiveRecording,
  visibility: ScreenVisibility
) =>
  Effect.gen(function* observeFocusOnce() {
    const at = Math.max(
      0,
      (yield* Clock.currentTimeMillis) - recording.startedAt
    );
    if (visibility === "visible") {
      if (recording.hiddenFrom !== undefined) {
        recording.hidden.push({
          fromMs: recording.hiddenFrom,
          toMs: Math.max(recording.hiddenFrom, at),
        });
        recording.hiddenFrom = undefined;
      }
    } else if (recording.hiddenFrom === undefined) {
      recording.hiddenFrom = at;
    }
  });

/**
 * A screen recorder over agent-device's `record` command. On Android the
 * screen's focus is checked once a second while it records, because
 * `screenrecord` draws a secure screen black without saying so; each span it
 * was hidden, or could not be classified, becomes a Hidden Interval.
 */
export const makeAgentDeviceScreenRecorder = (input: {
  /** Answers agent-device's own `record` result, parsed here. */
  readonly record: (options: {
    readonly action: "start" | "stop";
    readonly path?: string;
    readonly signal: AbortSignal;
  }) => Promise<typeof AgentDeviceRecordResult.Encoded>;
  /** Present on Android only. A failed read answers `unknown`. */
  readonly visibility?: Effect.Effect<ScreenVisibility>;
}): NativeScreenRecorder => {
  let active: ActiveRecording | undefined;
  const call = (
    what: string,
    options: { readonly action: "start" | "stop"; readonly path?: string }
  ) =>
    Effect.tryPromise({
      catch: (cause) =>
        new NativeScreenRecorderError({
          message: `The device's screen recorder could not ${what}${
            cause instanceof Error && cause.message.length > 0
              ? `: ${cause.message}`
              : "."
          }`,
        }),
      try: (signal) => input.record({ ...options, signal }),
    }).pipe(
      Effect.flatMap((answer) =>
        decodeRecordResult(answer).pipe(
          Effect.mapError(
            () =>
              new NativeScreenRecorderError({
                message: `The device's screen recorder gave an answer that could not be read when asked to ${what}.`,
              })
          )
        )
      )
    );
  return {
    start: (file) =>
      Effect.gen(function* startRecording() {
        if (active !== undefined) {
          return yield* Effect.fail(
            new NativeScreenRecorderError({
              message: "The device's screen recorder is already running.",
            })
          );
        }
        const result = yield* call("start", { action: "start", path: file });
        if (result.recording !== "started") {
          return yield* Effect.fail(
            new NativeScreenRecorderError({
              message: "The device's screen recorder did not report starting.",
            })
          );
        }
        const startedAt = yield* Clock.currentTimeMillis;
        const recording: ActiveRecording = {
          file,
          hidden: [],
          hiddenFrom: undefined,
          monitor: undefined,
          startedAt,
        };
        active = recording;
        const { visibility } = input;
        if (visibility !== undefined) {
          const check = visibility.pipe(
            Effect.flatMap((seen) => observeFocus(recording, seen))
          );
          yield* check;
          recording.monitor = yield* check.pipe(
            Effect.repeat(Schedule.spaced("1 second")),
            Effect.forkDetach
          );
        }
        return startedAt;
      }),
    stop: () =>
      Effect.gen(function* stopRecording() {
        const recording = active;
        if (recording === undefined) {
          return yield* Effect.fail(
            new NativeScreenRecorderError({
              message: "The device's screen recorder is not running.",
            })
          );
        }
        active = undefined;
        if (recording.monitor !== undefined) {
          yield* Fiber.interrupt(recording.monitor);
        }
        const stoppedAt = yield* Clock.currentTimeMillis;
        if (recording.hiddenFrom !== undefined) {
          recording.hidden.push({
            fromMs: recording.hiddenFrom,
            toMs: Math.max(
              recording.hiddenFrom,
              stoppedAt - recording.startedAt
            ),
          });
        }
        const result = yield* call("stop", { action: "stop" });
        if (result.recording !== "stopped") {
          return yield* Effect.fail(
            new NativeScreenRecorderError({
              message: "The device's screen recorder did not report stopping.",
            })
          );
        }
        return {
          capturedDurationMs: elapsed(result.capturedDurationMs),
          devicePath: devicePathState(result.nativePathDisposition),
          durationMs:
            elapsed(result.durationMs) ?? stoppedAt - recording.startedAt,
          files: footageFiles(recording.file, result),
          hidden: recording.hidden,
          recorder: recorderState(result.recorder),
          warning:
            result.warning === undefined || result.warning.length === 0
              ? undefined
              : result.warning,
        } satisfies NativeScreenRecording;
      }),
  };
};
