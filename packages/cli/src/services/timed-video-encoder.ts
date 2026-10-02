import { spawn } from "node:child_process";

import type { BrowserRpcErrorType } from "@contingency/protocol";
import { Effect } from "effect";
import type { Scope } from "effect";

import { browserFailure } from "./create-browser-session.ts";
import { awaitExit, findFfmpeg } from "./ffmpeg.ts";

// A minimal Matroska writer: one MJPEG track, one frame per Cluster, each
// Cluster stamped in milliseconds. ffmpeg reads the stamps as written, so a
// frame's place in the video is decided here rather than by when it reached
// the pipe.

const vint = (value: number): Buffer => {
  let length = 1;
  while (value >= 2 ** (7 * length) - 1) {
    length += 1;
  }
  const buffer = Buffer.alloc(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    buffer[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  // The length marker: the first byte's leading bits are clear, so adding
  // the marker bit sets it.
  buffer[0] = (buffer[0] ?? 0) + 2 ** (8 - length);
  return buffer;
};

const uint = (value: number): Buffer => {
  if (value === 0) {
    return Buffer.from([0]);
  }
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0) {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from(bytes);
};

const element = (id: string, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from(id, "hex"), vint(payload.length), payload]);

/** The EBML header, an unsized Segment, its Info, and the one MJPEG track. */
export const matroskaHeader = (): Buffer =>
  Buffer.concat([
    element(
      "1A45DFA3",
      Buffer.concat([
        element("4286", uint(1)),
        element("42F7", uint(1)),
        element("42F2", uint(4)),
        element("42F3", uint(8)),
        element("4282", Buffer.from("matroska")),
        element("4287", uint(4)),
        element("4285", uint(2)),
      ])
    ),
    Buffer.from("18538067", "hex"),
    // An unknown Segment size, so Clusters can stream in without a rewrite.
    Buffer.from("01FFFFFFFFFFFFFF", "hex"),
    // TimestampScale of 1,000,000ns: Cluster timestamps are milliseconds.
    element("1549A966", element("2AD7B1", uint(1_000_000))),
    element(
      "1654AE6B",
      element(
        "AE",
        Buffer.concat([
          element("D7", uint(1)),
          element("73C5", uint(1)),
          element("83", uint(1)),
          element("9C", uint(0)),
          element("86", Buffer.from("V_MJPEG")),
          // Placeholder dimensions. The MJPEG decoder reads each frame's own,
          // and a larger placeholder can make ffmpeg mistake a short
          // progressive JPEG for an interlaced field.
          element(
            "E0",
            Buffer.concat([element("B0", uint(1)), element("BA", uint(1))])
          ),
        ])
      )
    ),
  ]);

/** One Cluster holding one keyframe SimpleBlock, up to the frame bytes. */
export const matroskaClusterHeader = (
  timestampMs: number,
  frameLength: number
): Buffer => {
  const block = Buffer.concat([
    Buffer.from("A3", "hex"),
    vint(4 + frameLength),
    vint(1),
    Buffer.from([0, 0]),
    Buffer.from([0x80]),
  ]);
  const timestamp = element("E7", uint(Math.max(0, Math.round(timestampMs))));
  return Buffer.concat([
    Buffer.from("1F43B675", "hex"),
    vint(timestamp.length + block.length + frameLength),
    timestamp,
    block,
  ]);
};

/**
 * Every output frame is scaled to one size, because Chromium's screencast
 * frames follow the device pixel ratio and a tab switch can change them. The
 * stamps pass through untouched, so a still Page costs no frames at all.
 *
 * Unlike Playwright's recorder, input probing is left at its defaults:
 * shortening it makes ffmpeg guess a frame rate from the first frames and
 * drop the ones a sparse, repaint-driven stream stamps between its ticks.
 * The encoder counts in milliseconds for the same reason: left to itself it
 * counts in ticks of the guessed rate, so a caret blinking at 2fps would
 * round every later frame to the half second.
 */
const ffmpegArguments = (
  output: string,
  width: number,
  height: number
): readonly string[] => [
  "-loglevel",
  "error",
  "-f",
  "matroska",
  "-i",
  "pipe:0",
  "-an",
  "-vf",
  `scale=${width}:${height}`,
  "-fps_mode",
  "passthrough",
  "-enc_time_base",
  "1/1000",
  "-c:v",
  "libvpx",
  "-qmin",
  "0",
  "-qmax",
  "50",
  "-crf",
  "8",
  "-b:v",
  "1M",
  // Match Playwright's live recorder: real-time VP8 does not compete with
  // Chromium for CPU while a Run is still driving the browser.
  "-deadline",
  "realtime",
  "-cpu-used",
  "8",
  "-threads",
  "1",
  "-y",
  output,
];

export interface TimedVideoEncoder {
  /**
   * Show one JPEG frame from `atMs` until the next. A lossy encoder drops the
   * frame while ffmpeg is busy; a lossless one waits for the pipe to drain.
   * Never fails the caller: a problem is reported through `finish`.
   */
  readonly write: (frame: Uint8Array, atMs: number) => Effect.Effect<void>;
  /** Close the input and wait for the file; the failure, if any. */
  readonly finish: Effect.Effect<string | undefined>;
}

export interface TimedVideoEncoderOptions {
  readonly height: number;
  /** Names the encoder in failures, such as "Run footage". */
  readonly label: string;
  /** Drop frames while ffmpeg is busy rather than wait for it. */
  readonly lossy: boolean;
  readonly output: string;
  readonly width: number;
}

interface EncoderState {
  draining: boolean;
  failure: string | undefined;
  finished: boolean;
}

/**
 * A scoped ffmpeg process that turns timestamped JPEG frames into one VP8
 * webm. Closing the scope without `finish` kills it: an unfinished file is
 * not worth waiting for.
 */
export const makeTimedVideoEncoder = (
  options: TimedVideoEncoderOptions
): Effect.Effect<TimedVideoEncoder, BrowserRpcErrorType, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      catch: (cause) =>
        browserFailure(`Could not start the ${options.label} encoder`, cause),
      try: () => {
        const state: EncoderState = {
          draining: false,
          failure: undefined,
          finished: false,
        };
        const child = spawn(
          findFfmpeg(),
          ffmpegArguments(options.output, options.width, options.height),
          { stdio: ["pipe", "ignore", "pipe"] }
        );
        let stderr = "";
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = `${stderr}${chunk.toString("utf-8")}`.slice(-2048);
        });
        // EPIPE arrives here rather than at `write` when ffmpeg dies, so both
        // listeners keep the failure out of the uncaught handler.
        child.stdin?.on("error", () => {
          state.finished = true;
          state.failure ??= `The ${options.label} encoder stopped unexpectedly.`;
        });
        child.on("error", (cause: Error) => {
          state.finished = true;
          state.failure ??= `The ${options.label} encoder failed: ${cause.message}`;
        });
        child.on("close", (code) => {
          state.finished = true;
          if (code !== 0 && code !== null) {
            state.failure ??= `The ${options.label} encoder exited unexpectedly${stderr.length > 0 ? `: ${stderr.trim()}` : "."}`;
          }
        });
        child.stdin?.write(matroskaHeader());
        return { child, state };
      },
    }),
    ({ child }) =>
      Effect.sync(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      })
  ).pipe(
    Effect.map(({ child, state }) => {
      const finish = Effect.promise(async () => {
        if (!state.finished) {
          state.finished = true;
          child.stdin?.end();
        }
        await awaitExit(child);
        return state.failure;
      });
      const drained = Effect.callback<boolean>((resume) => {
        const { stdin } = child;
        if (stdin === null || stdin.destroyed || !state.draining) {
          resume(Effect.succeed(true));
          return;
        }
        const settle = () => {
          stdin.off("drain", settle);
          stdin.off("close", settle);
          resume(Effect.succeed(true));
        };
        stdin.once("drain", settle);
        stdin.once("close", settle);
        return Effect.sync(() => {
          stdin.off("drain", settle);
          stdin.off("close", settle);
        });
      });
      const write = (frame: Uint8Array, atMs: number): Effect.Effect<void> =>
        Effect.suspend(() => {
          const { stdin } = child;
          if (
            state.finished ||
            stdin === null ||
            stdin.destroyed ||
            frame.byteLength === 0
          ) {
            return Effect.void;
          }
          if (state.draining) {
            if (options.lossy) {
              return Effect.logDebug(
                `Dropped a frame while the ${options.label} encoder was busy.`
              );
            }
            return drained.pipe(Effect.andThen(write(frame, atMs)));
          }
          stdin.write(matroskaClusterHeader(atMs, frame.byteLength));
          if (stdin.write(frame) === false) {
            state.draining = true;
            stdin.once("drain", () => {
              state.draining = false;
            });
          }
          return Effect.void;
        });
      return { finish, write };
    })
  );
