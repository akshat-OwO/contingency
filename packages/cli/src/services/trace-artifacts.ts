import { createWriteStream } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
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
      const backup = `${file}.unscrubbed`;
      const archive = new yazl.ZipFile();
      for (const [name, contents] of entries) {
        archive.addBuffer(contents, name);
      }
      archive.end();
      await pipeline(archive.outputStream, createWriteStream(temporary));

      await rename(file, backup);
      try {
        await rename(temporary, file);
        await rm(backup, { force: true });
      } catch (error) {
        await rename(backup, file);
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
 * Remove exact secret values from UTF-8 trace entries where Playwright leaves
 * them readable. Binary screenshots and encoded payloads remain untouched, so
 * this is deliberately only best effort and never makes a Trace safe to share.
 */
export const scrubTraceBestEffort = (
  file: string,
  secrets: readonly string[]
): Effect.Effect<void, Error> =>
  Effect.gen(function* scrubTrace() {
    if (secrets.length === 0) {
      return;
    }
    const entries = yield* readArchive(file);
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
      }
    }
    yield* writeArchive(file, entries);
  });

/**
 * Store the exact per-Step screenshots inside the Trace archive. Playwright's
 * screencast is paint-driven and may omit an unchanged Page, while these
 * explicit entries preserve one unambiguous cut point for every Step.
 */
export const embedVideoFrames = (
  file: string,
  stepFrames: ReadonlyMap<number, Buffer>,
  settledFrame: Buffer
): Effect.Effect<void, Error> =>
  Effect.gen(function* embedFrames() {
    const entries = yield* readArchive(file);
    for (const [index, frame] of stepFrames) {
      entries.set(stepFrameName(index), frame);
    }
    entries.set(SETTLED_FRAME_NAME, settledFrame);
    yield* writeArchive(file, entries);
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

/** Generate a fixed-duration WebM frame for every executed Step, then settle. */
export const deriveVideoFromTrace = (
  traceFile: string,
  videoFile: string,
  stepIndexes: readonly number[]
): Effect.Effect<
  DerivedVideo,
  Error,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* deriveVideo() {
    const entries = yield* readArchive(traceFile);
    const images: Buffer[] = [];
    for (const index of stepIndexes) {
      const contents = entries.get(stepFrameName(index));
      if (contents === undefined) {
        throw new Error(`The Trace is missing the frame for Step ${index}.`);
      }
      images.push(contents);
    }
    const settledFrame = entries.get(SETTLED_FRAME_NAME);
    if (settledFrame === undefined) {
      throw new Error("The Trace is missing its final settled frame.");
    }
    images.push(settledFrame);
    const ffmpeg = playwrightRegistry.registry
      .findExecutable("ffmpeg")
      .executablePath();
    yield* encodeFrames(ffmpeg, images, videoFile);
    return {
      includesSettledState: true,
      steps: stepIndexes,
    };
  });

/** A cheap integrity check used before a Trace is recorded in its manifest. */
export const traceWasWritten = async (file: string): Promise<boolean> => {
  const contents = await readFile(file);
  return (
    contents.length > 4 && contents.subarray(0, 2).toString("ascii") === "PK"
  );
};
