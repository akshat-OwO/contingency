import { createWriteStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import { Effect, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ChildProcess } from "effect/unstable/process";
import { registry as playwrightRegistry } from "playwright-core/lib/coreBundle";
import { yauzl, yazl } from "playwright-core/lib/utilsBundle";

/** Every derived frame remains visible for this long. */
export const VIDEO_FRAME_DURATION_SECONDS = 0.5;

export interface DerivedVideo {
  readonly includesSettledState: boolean;
  readonly steps: readonly number[];
}

export interface PreparedTraceArtifacts {
  readonly videoFrames?: {
    readonly settled: Buffer;
    readonly steps: ReadonlyMap<number, Buffer>;
  };
}

const VIDEO_FRAME_DIRECTORY = "contingency/video";

const stepFrameName = (index: number): string =>
  `${VIDEO_FRAME_DIRECTORY}/step-${index}.jpeg`;

const SETTLED_FRAME_NAME = `${VIDEO_FRAME_DIRECTORY}/settled.jpeg`;

const readArchive = (file: string): Effect.Effect<Map<string, Buffer>, Error> =>
  Effect.tryPromise({
    catch: (cause) => new Error(`Could not read ${file}: ${String(cause)}`),
    try: async () => {
      const archive = await yauzl.openPromise(file, { lazyEntries: true });
      const entries = new Map<string, Buffer>();
      for await (const entry of archive.eachEntry()) {
        const stream = await archive.openReadStreamPromise(entry);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        entries.set(entry.fileName, Buffer.concat(chunks));
      }
      return entries;
    },
  });

const writeArchive = (
  file: string,
  entries: ReadonlyMap<string, Buffer>
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    catch: (cause) => new Error(`Could not rewrite ${file}: ${String(cause)}`),
    try: async () => {
      const temporary = `${file}.scrubbed`;
      const archive = new yazl.ZipFile();
      for (const [name, contents] of entries) {
        archive.addBuffer(contents, name);
      }
      archive.end();
      await pipeline(archive.outputStream, createWriteStream(temporary));

      try {
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  });

const textBuffer = (contents: Buffer): string | undefined => {
  const decoded = contents.toString("utf-8");
  return Buffer.from(decoded, "utf-8").equals(contents) ? decoded : undefined;
};

/**
 * Prepare the stopped Trace in one pass: remove exact secret values from UTF-8
 * entries and, when video was requested, store its explicit frame boundaries.
 * Binary payloads remain untouched, so scrubbing is deliberately best effort
 * and never makes a Trace safe to share.
 */
export const prepareTraceArtifacts = (
  file: string,
  secrets: readonly string[],
  videoFrames?: {
    readonly settled: Buffer;
    readonly steps: ReadonlyMap<number, Buffer>;
  }
): Effect.Effect<PreparedTraceArtifacts, Error> =>
  Effect.gen(function* prepareTrace() {
    if (secrets.length === 0 && videoFrames === undefined) {
      return {};
    }
    const entries = yield* readArchive(file);
    let rewrite = false;
    for (const [name, contents] of entries) {
      const decoded = textBuffer(contents);
      if (decoded === undefined) {
        continue;
      }
      let scrubbed = decoded;
      for (const secret of secrets) {
        if (secret.length > 0) {
          scrubbed = scrubbed.replaceAll(secret, "[REDACTED]");
        }
      }
      if (scrubbed !== decoded) {
        entries.set(name, Buffer.from(scrubbed, "utf-8"));
        rewrite = true;
      }
    }
    if (videoFrames !== undefined) {
      for (const [index, frame] of videoFrames.steps) {
        entries.set(stepFrameName(index), frame);
      }
      entries.set(SETTLED_FRAME_NAME, videoFrames.settled);
      rewrite = true;
    }
    if (rewrite) {
      yield* writeArchive(file, entries);
    }
    return videoFrames === undefined ? {} : { videoFrames };
  });

const encodeFrames = (
  ffmpeg: string,
  frames: readonly Buffer[],
  videoFile: string
): Effect.Effect<void, Error, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* encodeVideo() {
      const encoder = yield* ChildProcess.make(
        ffmpeg,
        [
          "-y",
          "-loglevel",
          "error",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "-framerate",
          String(1 / VIDEO_FRAME_DURATION_SECONDS),
          "-i",
          "pipe:0",
          "-c:v",
          "libvpx",
          "-deadline",
          "realtime",
          "-cpu-used",
          "8",
          "-pix_fmt",
          "yuv420p",
          videoFile,
        ],
        {
          stdin: Stream.fromIterable(frames),
          stdout: "ignore",
        }
      );
      const [code, stderr] = yield* Effect.all(
        [
          encoder.exitCode,
          encoder.stderr.pipe(Stream.decodeText(), Stream.mkString),
        ],
        { concurrency: "unbounded" }
      );
      if (Number(code) !== 0) {
        return yield* Effect.fail(
          new Error(
            stderr.trim() ||
              `The video encoder exited with status ${String(code)}.`
          )
        );
      }
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error
          ? cause
          : new Error(`Could not run the video encoder: ${String(cause)}`)
      )
    )
  );

/**
 * Generate the video from the exact frames committed by Trace preparation,
 * without reopening and inflating the archive a second time.
 */
export const deriveVideoFromTrace = (
  prepared: PreparedTraceArtifacts,
  videoFile: string,
  stepIndexes: readonly number[]
): Effect.Effect<
  DerivedVideo,
  Error,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* deriveVideo() {
    const frames = prepared.videoFrames;
    if (frames === undefined) {
      return yield* Effect.fail(
        new Error("The Trace has no prepared video frames.")
      );
    }
    const images: Buffer[] = [];
    for (const index of stepIndexes) {
      const contents = frames.steps.get(index);
      if (contents === undefined) {
        return yield* Effect.fail(
          new Error(`The Trace is missing the frame for Step ${index}.`)
        );
      }
      images.push(contents);
    }
    images.push(frames.settled);
    const executable = playwrightRegistry.registry.findExecutable("ffmpeg");
    if (executable === undefined) {
      return yield* Effect.fail(
        new Error("Playwright's ffmpeg executable is unavailable.")
      );
    }
    const ffmpeg = executable.executablePath();
    yield* encodeFrames(ffmpeg, images, videoFile);
    return {
      includesSettledState: true,
      steps: stepIndexes,
    };
  });

/** A cheap integrity check used before a Trace is recorded in its manifest. */
export const traceWasWritten = async (file: string): Promise<boolean> => {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return (
      bytesRead === header.length && header.toString("ascii", 0, 2) === "PK"
    );
  } finally {
    await handle.close();
  }
};
