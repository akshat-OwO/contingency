import { statSync } from "node:fs";

import type { BrowserRpcErrorType } from "@contingency/protocol";
import { Effect, Option } from "effect";
import type { Scope } from "effect";

import { spawnChild } from "./child-process.ts";
import { browserFailure } from "./create-browser-session.ts";
import {
  ENCODER_EXIT_TIMEOUT_MS,
  encoderFailure,
  findFfmpeg,
} from "./ffmpeg.ts";

/**
 * The bundled ffmpeg accepts `pipe:0` but not the `-` shorthand, and it ships
 * exactly the pieces this pipeline needs: the `image2pipe` demuxer, the
 * `mjpeg` decoder, `libvpx-vp9`, and the `webm` muxer.
 *
 * Screencast frames arrive whenever Chrome repaints, so the encoder must keep
 * their real spacing rather than assume a frame rate:
 * `-use_wallclock_as_timestamps 1` stamps each decoded frame with its arrival
 * time and `-fps_mode vfr` writes those timestamps through to the file instead
 * of duplicating or dropping frames to hit a constant rate.
 */
const ffmpegArguments = (output: string): readonly string[] => [
  "-loglevel",
  "error",
  "-f",
  "image2pipe",
  "-c:v",
  "mjpeg",
  "-use_wallclock_as_timestamps",
  "1",
  "-i",
  "pipe:0",
  "-c:v",
  "libvpx-vp9",
  // Match Playwright's live recorder: avoid offline VP9 encoding competing
  // with Chromium for CPU while the user is driving the browser, and emit
  // each frame as it arrives instead of holding a lookahead queue.
  "-deadline",
  "realtime",
  "-cpu-used",
  "8",
  "-lag-in-frames",
  "0",
  "-row-mt",
  "1",
  "-threads",
  "1",
  "-fps_mode",
  "vfr",
  "-y",
  output,
];

export const formatVideoBytes = (bytes: number): string =>
  `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`;

export interface TeachingEncoder {
  /** Hand one screencast frame to the encoder. Never fails the caller. */
  readonly write: (frame: Uint8Array) => Effect.Effect<void>;
  /** Whether any frame was handed to ffmpeg, independently of output buffering. */
  readonly hasFrames: Effect.Effect<boolean>;
  /** Current encoded output file size on disk. */
  readonly bytesWritten: Effect.Effect<number>;
  /** Set when ffmpeg died or the size bound tripped. */
  readonly failure: Effect.Effect<string | undefined>;
  /** The same reading, for the recorder's synchronous watchdog tick. */
  readonly unsafeFailure: (bytes: number) => string | undefined;
}

export interface TeachingEncoderOptions {
  /** Hard ceiling on the encoded output file, in bytes. */
  readonly maxBytes: number;
  readonly output: string;
}

interface EncoderState {
  draining: boolean;
  failure: string | undefined;
  finished: boolean;
  hasFrames: boolean;
}

/**
 * A scoped ffmpeg process that turns the browser's screencast frames into one
 * playable VP9 webm. Nothing here fails the caller: a recording that loses its
 * video is still a recording, so an encoder problem is reported through
 * `failure` and turned into a visible Teaching failure by the recorder.
 */
export const makeTeachingEncoder = (
  options: TeachingEncoderOptions
): Effect.Effect<TeachingEncoder, BrowserRpcErrorType, Scope.Scope> =>
  Effect.gen(function* startTeachingEncoder() {
    const state: EncoderState = {
      draining: false,
      failure: undefined,
      finished: false,
      hasFrames: false,
    };
    let stdinFailed = false;
    const ffmpeg = yield* Effect.try({
      catch: (cause) =>
        browserFailure("Could not start the Teaching video encoder", cause),
      try: findFfmpeg,
    });
    const encoder = yield* spawnChild(
      "ffmpeg",
      ffmpeg,
      ffmpegArguments(options.output),
      { stdio: ["pipe", "ignore", "pipe"] },
      {
        onExit: (_, failure) =>
          Effect.gen(function* encoderExited() {
            state.finished = true;
            if (state.failure !== undefined) {
              return;
            }
            if (Option.isSome(failure)) {
              state.failure = yield* encoderFailure(
                "The Teaching video encoder",
                failure.value
              );
            } else if (stdinFailed) {
              state.failure =
                "The Teaching video encoder stopped unexpectedly.";
            }
          }),
        // A scope that closes before the input ends kills the encoder.
        stop: { graceMs: ENCODER_EXIT_TIMEOUT_MS },
      }
    ).pipe(
      Effect.mapError((cause) =>
        browserFailure("Could not start the Teaching video encoder", cause)
      )
    );
    const child = encoder.process;
    // EPIPE arrives here rather than at the `write` call when ffmpeg dies
    // mid-recording, so this listener keeps the failure out of the Agent
    // Session's uncaught handler. The exit that follows says why.
    child.stdin?.on("error", () => {
      state.finished = true;
      stdinFailed = true;
    });
    // Ending the input lets ffmpeg finish the file; it is killed only if it
    // overstays.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        state.finished = true;
        child.stdin?.end();
      }).pipe(
        Effect.andThen(
          encoder.stop({ graceMs: ENCODER_EXIT_TIMEOUT_MS, signal: null })
        )
      )
    );
    return { child, state };
  }).pipe(
    Effect.map(({ child, state }) => {
      let lastBytes = 0;
      const outputBytes = () => {
        try {
          lastBytes =
            statSync(options.output, { throwIfNoEntry: false })?.size ??
            lastBytes;
          return lastBytes;
        } catch (error) {
          Effect.runSync(
            Effect.logDebug(
              "Could not measure the Teaching video size; keeping the last measurement",
              { error }
            )
          );
          return lastBytes;
        }
      };
      const failure = (bytes: number) => {
        if (bytes > options.maxBytes) {
          state.failure ??= `Teaching stopped to protect disk space because the encoded output file size of ${formatVideoBytes(bytes)} exceeds the hard limit of ${formatVideoBytes(options.maxBytes)}. Captured content is retained and recoverable.`;
        }
        return state.failure;
      };
      return {
        bytesWritten: Effect.sync(outputBytes),
        failure: Effect.sync(() => failure(outputBytes())),
        hasFrames: Effect.sync(() => state.hasFrames),
        unsafeFailure: failure,
        write: (frame: Uint8Array) =>
          Effect.suspend(() => {
            const { stdin } = child;
            if (state.finished || stdin === null || stdin.destroyed) {
              return Effect.void;
            }
            if (frame.byteLength === 0) {
              return Effect.void;
            }
            // Video fidelity is worth less than the session's memory. Once
            // ffmpeg stops reading, frames are dropped until its pipe drains
            // rather than queued into an unbounded Node write buffer.
            if (state.draining) {
              return Effect.logDebug(
                "Dropped a Teaching frame while the video encoder was busy."
              );
            }
            state.hasFrames = true;
            if (stdin.write(frame) === false) {
              state.draining = true;
              stdin.once("drain", () => {
                state.draining = false;
              });
            }
            return Effect.void;
          }),
      };
    })
  );
