import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import type { BrowserRpcErrorType } from "@contingency/protocol";
import { Effect } from "effect";
import type { Scope } from "effect";
import { registry as playwrightRegistry } from "playwright-core/lib/coreBundle";

import { browserFailure } from "./create-browser-session.ts";

/**
 * How long a finalizing encoder may take to flush and exit before it is
 * killed. Closing the Teaching scope must never hang the Agent Session, and a
 * VP8 encoder with a full frame queue still drains well inside this window.
 */
const ENCODER_EXIT_TIMEOUT_MS = 10_000;

/**
 * The bundled ffmpeg accepts `pipe:0` but not the `-` shorthand, and it ships
 * exactly the pieces this pipeline needs: the `image2pipe` demuxer, the
 * `mjpeg` decoder, `libvpx`, and the `webm` muxer.
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
  "libvpx",
  "-fps_mode",
  "vfr",
  "-y",
  output,
];

export interface TeachingEncoder {
  /** Hand one screencast frame to the encoder. Never fails the caller. */
  readonly write: (jpegBase64: string) => Effect.Effect<void>;
  /** Bytes written so far, for the size bound. */
  readonly bytesWritten: Effect.Effect<number>;
  /** Set when ffmpeg died or the size bound tripped. */
  readonly failure: Effect.Effect<string | undefined>;
  /** The same reading, for the recorder's synchronous watchdog tick. */
  readonly unsafeFailure: () => string | undefined;
}

export interface TeachingEncoderOptions {
  /**
   * The ceiling on encoder input. MJPEG frames are far larger than the VP8
   * they become, so bounding the input bounds the output file conservatively:
   * the encoder stops before the recording can fill a disk.
   */
  readonly maxBytes: number;
  readonly output: string;
}

interface EncoderState {
  bytes: number;
  draining: boolean;
  failure: string | undefined;
  finished: boolean;
}

const findFfmpeg = (): string => {
  const executable = playwrightRegistry.registry.findExecutable("ffmpeg");
  if (executable === undefined) {
    throw new Error("Playwright's ffmpeg executable is unavailable.");
  }
  return executable.executablePath();
};

/** Wait for ffmpeg to flush and exit, killing it if it overstays. */
const awaitExit = (process: ChildProcess): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- ChildProcess has no exit Promise.
  new Promise((resolve) => {
    if (process.exitCode !== null || process.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
    }, ENCODER_EXIT_TIMEOUT_MS);
    timer.unref?.();
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    process.once("close", settle);
    process.once("error", settle);
  });

/**
 * A scoped ffmpeg process that turns the browser's screencast frames into one
 * playable VP8 webm. Nothing here fails the caller: a recording that loses its
 * video is still a recording, so an encoder problem is reported through
 * `failure` and turned into a visible Teaching failure by the recorder.
 */
export const makeTeachingEncoder = (
  options: TeachingEncoderOptions
): Effect.Effect<TeachingEncoder, BrowserRpcErrorType, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: (cause) =>
        browserFailure("Could not start the Teaching video encoder", cause),
      try: () => {
        const state: EncoderState = {
          bytes: 0,
          draining: false,
          failure: undefined,
          finished: false,
        };
        const child = spawn(findFfmpeg(), ffmpegArguments(options.output), {
          stdio: ["pipe", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString("utf-8")}`.slice(-2048);
        });
        // EPIPE arrives here rather than at the `write` call when ffmpeg dies
        // mid-recording, so both listeners are required to keep the failure
        // out of the Agent Session's uncaught handler.
        child.stdin?.on("error", () => {
          state.finished = true;
          state.failure ??= "The Teaching video encoder stopped unexpectedly.";
        });
        child.on("error", (cause: Error) => {
          state.finished = true;
          state.failure ??= `The Teaching video encoder failed: ${cause.message}`;
        });
        child.on("close", (code) => {
          state.finished = true;
          if (code !== 0 && code !== null) {
            state.failure ??= `The Teaching video encoder exited unexpectedly${stderr.length > 0 ? `: ${stderr.trim()}` : "."}`;
          }
        });
        return { child, state };
      },
    }),
    ({ child, state }) =>
      Effect.promise(async () => {
        state.finished = true;
        child.stdin?.end();
        await awaitExit(child);
      }),
    { interruptible: false }
  ).pipe(
    Effect.map(({ child, state }) => ({
      bytesWritten: Effect.sync(() => state.bytes),
      failure: Effect.sync(() => state.failure),
      unsafeFailure: () => state.failure,
      write: (jpegBase64: string) =>
        Effect.suspend(() => {
          const { stdin } = child;
          if (state.finished || stdin === null || stdin.destroyed) {
            return Effect.void;
          }
          const frame = Buffer.from(jpegBase64, "base64");
          if (frame.byteLength === 0) {
            return Effect.void;
          }
          if (state.bytes + frame.byteLength > options.maxBytes) {
            state.finished = true;
            state.failure ??=
              "Teaching stopped because the recording reached its video size limit.";
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
          state.bytes += frame.byteLength;
          if (stdin.write(frame) === false) {
            state.draining = true;
            stdin.once("drain", () => {
              state.draining = false;
            });
          }
          return Effect.void;
        }),
    }))
  );
