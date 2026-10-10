import path from "node:path";

import type { RunVideoStatus } from "@contingency/protocol";
import {
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import type { Page } from "playwright-core";

import { parseByteRange } from "./byte-range.ts";
import { CreateBrowser } from "./create-browser-contract.ts";
import { tryBrowser } from "./create-browser-session.ts";
import {
  FOOTAGE_MANIFEST_FILE,
  FOOTAGE_VIDEO_FILE,
  FootageManifest,
} from "./run-footage.ts";
import { compositorPage } from "./run-video-compositor-page.ts";
import type { CompositorFrame } from "./run-video-compositor-page.ts";
import { cursorAt, planCursorStrokes } from "./run-video-cursor.ts";
import {
  fastForwardLabel,
  planRunVideo,
  RUN_VIDEO_FRAME_MS,
  runOffsetAtVideo,
  runVideoDurationMs,
  segmentAtVideo,
} from "./run-video-plan.ts";
import { makeTimedVideoEncoder } from "./timed-video-encoder.ts";

/** The video a Run Summary names. It exists once the footage is condensed. */
export const RUN_VIDEO_FILE = "run.webm";
const PARTIAL_VIDEO_FILE = "run.partial.webm";
/** Held by the process condensing a Run's footage, naming its pid. */
const LOCK_FILE = "run-video.lock";
/** Written when the real-time footage stands in for the condensed video. */
const FALLBACK_FILE = "run-video-fallback.json";

const COMPOSITOR_ORIGIN = "http://run-video.contingency.invalid";
/** The most footage one range answer carries; the media element asks again. */
const FOOTAGE_CHUNK_BYTES = 4 * 1024 * 1024;
/** One frame should take milliseconds; this only catches a wedged page. */
const FRAME_TIMEOUT = "30 seconds";

const Fallback = Schema.Struct({ reason: Schema.String });

export interface RunVideoRendererService {
  /**
   * Condense the footage in a Run's directory into its video, in the
   * background. A second call while one is under way does nothing.
   */
  readonly render: (directory: string) => Effect.Effect<void>;
  /**
   * Where the directory's video stands. Footage left behind by a process
   * that exited mid-encode is picked up again here.
   */
  readonly status: (directory: string) => Effect.Effect<RunVideoStatus>;
  /**
   * Wait for this process's render attempt, including footage cleanup. Starts
   * recovery like `status` when a finished Run's manifest remains on disk.
   * Read `status` afterwards to learn whether the video is available.
   */
  readonly settled: (directory: string) => Effect.Effect<void>;
}

export const RunVideoRenderer = Context.Service<RunVideoRendererService>(
  "@contingency/RunVideoRenderer"
);

const failure = (message: string) => new Error(message);

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still means a process holds the pid.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** Parse a JSON file another process may have written, then validate it. */
const decodeJson =
  <A>(schema: Schema.Decoder<A>, what: string) =>
  (contents: string): Effect.Effect<A, Error> =>
    Effect.try({
      catch: () => failure(`${what} is not valid JSON.`),
      try: () => JSON.parse(contents),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((cause) =>
        failure(`${what} could not be read: ${cause.message}`)
      )
    );

/** The footage frame showing at `atMs`: the last painted at or before it. */
const frameIndexAt = (frames: readonly number[], atMs: number): number => {
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((frames[middle] ?? 0) <= atMs) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
};

const rounded = (value: number): number => Math.round(value * 10) / 10;

export const RunVideoRendererLive = Layer.effect(
  RunVideoRenderer,
  Effect.gen(function* makeRunVideoRenderer() {
    const fileSystem = yield* FileSystem.FileSystem;
    const browser = yield* CreateBrowser;
    const scope = yield* Effect.scope;
    /**
     * Directories this process is condensing. An entry lasts until the
     * footage is removed, not only until `run.webm` appears.
     */
    const inFlight = new Map<string, Deferred.Deferred<void>>();

    const exists = (file: string) =>
      fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));

    /**
     * Take the directory's lock, or learn another live process holds it. A
     * lock whose process is gone is stale and taken over.
     */
    const acquireLock = (directory: string): Effect.Effect<boolean> =>
      Effect.gen(function* lockRunVideo() {
        const file = path.join(directory, LOCK_FILE);
        for (const _attempt of [0, 1]) {
          const created = yield* Effect.result(
            fileSystem.writeFileString(file, String(process.pid), {
              flag: "wx",
              mode: 0o600,
            })
          );
          if (created._tag === "Success") {
            return true;
          }
          const holder = Number(
            (yield* fileSystem
              .readFileString(file)
              .pipe(Effect.orElseSucceed(() => ""))).trim()
          );
          if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) {
            return false;
          }
          yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
        }
        return false;
      });

    const serveCompositor = (page: Page, footage: string, html: string) =>
      tryBrowser("Could not prepare the video compositor", () =>
        page.route(`${COMPOSITOR_ORIGIN}/**`, async (route) => {
          const url = new URL(route.request().url());
          if (url.pathname !== "/footage") {
            await route.fulfill({ body: html, contentType: "text/html" });
            return;
          }
          const answer = await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* readFootageRange() {
                const file = yield* fileSystem.open(footage, { flag: "r" });
                const size = Number((yield* file.stat).size);
                const asked = parseByteRange(
                  route.request().headers().range,
                  size
                ) ?? { end: size - 1, start: 0 };
                const end = Math.min(
                  asked.end,
                  asked.start + FOOTAGE_CHUNK_BYTES - 1
                );
                yield* file.seek(BigInt(asked.start), "start");
                const body = Option.getOrElse(
                  yield* file.readAlloc(end - asked.start + 1),
                  () => new Uint8Array()
                );
                return {
                  body,
                  end: asked.start + body.byteLength - 1,
                  size,
                  start: asked.start,
                };
              })
            ).pipe(Effect.result)
          );
          if (answer._tag === "Failure") {
            await route.fulfill({ status: 404 });
            return;
          }
          const { body, end, size, start } = answer.success;
          await route.fulfill({
            body: Buffer.from(body),
            headers: {
              "accept-ranges": "bytes",
              "content-range": `bytes ${start}-${end}/${size}`,
              "content-type": "video/webm",
            },
            status: 206,
          });
        })
      );

    const composeFrame = (page: Page, frame: CompositorFrame) =>
      tryBrowser("Could not draw a video frame", () =>
        page.evaluate<unknown>(`window.composeFrame(${JSON.stringify(frame)})`)
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
        Effect.timeoutOrElse({
          duration: FRAME_TIMEOUT,
          orElse: () =>
            Effect.fail(failure("Drawing a video frame took too long.")),
        }),
        Effect.flatMap((dataUrl) => {
          const comma = dataUrl.indexOf(",");
          return comma === -1
            ? Effect.fail(failure("A video frame came back empty."))
            : Effect.succeed(Buffer.from(dataUrl.slice(comma + 1), "base64"));
        })
      );

    /**
     * Replay the footage at the time map's pace, drawing the cursor and the
     * badge over each frame. A frame identical to the last is not drawn
     * again: an Idle Gap over a still Page costs one draw.
     */
    const condense = (directory: string, manifest: FootageManifest) =>
      Effect.scoped(
        Effect.gen(function* condenseFootage() {
          const segments = planRunVideo(manifest);
          const strokes = planCursorStrokes(manifest.pointers);
          const durationMs = runVideoDurationMs(segments);
          const page = yield* browser.compositor({
            height: manifest.height,
            width: manifest.width,
          });
          yield* serveCompositor(
            page,
            path.join(directory, FOOTAGE_VIDEO_FILE),
            compositorPage(manifest.width, manifest.height)
          );
          yield* tryBrowser("Could not open the video compositor", () =>
            page.goto(`${COMPOSITOR_ORIGIN}/`)
          );
          yield* tryBrowser("Could not load the Run footage", () =>
            page.evaluate<unknown>("window.footageReady.then(() => true)")
          );
          const encoder = yield* makeTimedVideoEncoder({
            height: manifest.height,
            label: "Run video",
            lossy: false,
            output: path.join(directory, PARTIAL_VIDEO_FILE),
            width: manifest.width,
          });
          const count = Math.max(1, Math.ceil(durationMs / RUN_VIDEO_FRAME_MS));
          let previous: { jpeg: Buffer; key: string } | undefined;
          for (let index = 0; index <= count; index += 1) {
            const videoMs = Math.min(index * RUN_VIDEO_FRAME_MS, durationMs);
            const runMs = runOffsetAtVideo(segments, videoMs);
            const frame = frameIndexAt(manifest.frames, runMs);
            const cursor = cursorAt(strokes, manifest.takeovers, runMs);
            const segment = segmentAtVideo(segments, videoMs);
            const drawn: CompositorFrame = {
              badge:
                segment?.kind === "idle-gap"
                  ? fastForwardLabel(segment.rate)
                  : null,
              cursor:
                cursor === undefined
                  ? null
                  : {
                      glyphScale: rounded(cursor.glyphScale),
                      opacity: rounded(cursor.opacity),
                      ringOpacity: rounded(cursor.ringOpacity),
                      ringScale: rounded(cursor.ringScale),
                      x: rounded(cursor.x),
                      y: rounded(cursor.y),
                    },
              // Just past the frame's own stamp, so rounding never lands on
              // the frame before it.
              seek: ((manifest.frames[frame] ?? 0) + 1) / 1000,
            };
            const key = JSON.stringify([frame, drawn.cursor, drawn.badge]);
            const jpeg =
              previous?.key === key
                ? previous.jpeg
                : yield* composeFrame(page, drawn);
            previous = { jpeg, key };
            yield* encoder.write(jpeg, videoMs);
          }
          const encoded = yield* encoder.finish;
          if (encoded !== undefined) {
            return yield* Effect.fail(failure(encoded));
          }
        })
      );

    const removeFootage = (directory: string) =>
      Effect.all(
        [FOOTAGE_VIDEO_FILE, FOOTAGE_MANIFEST_FILE, PARTIAL_VIDEO_FILE].map(
          (name) =>
            fileSystem
              .remove(path.join(directory, name), { force: true })
              .pipe(Effect.ignore)
        ),
        { discard: true }
      );

    /**
     * Keep the real-time footage as the Run's video and say why, so a video
     * that could not be condensed is still evidence rather than lost. The
     * footage is only deleted after it has become `run.webm`; a failed
     * rename leaves the source so a later status read can retry.
     */
    const fallBack = (directory: string, reason: string) =>
      Effect.gen(function* keepRealTimeFootage() {
        yield* Effect.logWarning(`Run video kept in real time: ${reason}`);
        const renamed = yield* Effect.result(
          fileSystem.rename(
            path.join(directory, FOOTAGE_VIDEO_FILE),
            path.join(directory, RUN_VIDEO_FILE)
          )
        );
        if (renamed._tag === "Failure") {
          return;
        }
        yield* fileSystem
          .writeFileString(
            path.join(directory, FALLBACK_FILE),
            JSON.stringify({ reason }),
            { mode: 0o600 }
          )
          .pipe(Effect.ignore);
        yield* removeFootage(directory);
      });

    /** A successful condense replaces any earlier real-time fallback note. */
    const keepCondensed = (directory: string) =>
      removeFootage(directory).pipe(
        Effect.andThen(
          fileSystem
            .remove(path.join(directory, FALLBACK_FILE), { force: true })
            .pipe(Effect.ignore)
        )
      );

    const readManifest = (directory: string) =>
      fileSystem
        .readFileString(path.join(directory, FOOTAGE_MANIFEST_FILE))
        .pipe(
          Effect.mapError((cause) =>
            failure(`The footage manifest could not be read: ${cause.message}`)
          ),
          Effect.flatMap(decodeJson(FootageManifest, "The footage manifest"))
        );

    const renderDirectory = (directory: string) =>
      Effect.gen(function* renderRunVideo() {
        if (!(yield* acquireLock(directory))) {
          return;
        }
        yield* Effect.gen(function* renderLocked() {
          if (yield* exists(path.join(directory, RUN_VIDEO_FILE))) {
            yield* removeFootage(directory);
            return;
          }
          if (!(yield* exists(path.join(directory, FOOTAGE_VIDEO_FILE)))) {
            return;
          }
          const manifest = yield* Effect.result(readManifest(directory));
          if (manifest._tag === "Failure") {
            yield* fallBack(directory, manifest.failure.message);
            return;
          }
          const condensed = yield* Effect.result(
            condense(directory, manifest.success)
          );
          if (condensed._tag === "Failure") {
            yield* fallBack(directory, condensed.failure.message);
            return;
          }
          yield* fileSystem
            .rename(
              path.join(directory, PARTIAL_VIDEO_FILE),
              path.join(directory, RUN_VIDEO_FILE)
            )
            .pipe(
              Effect.matchEffect({
                onFailure: (cause) => fallBack(directory, cause.message),
                onSuccess: () => keepCondensed(directory),
              })
            );
        }).pipe(
          Effect.ensuring(
            fileSystem
              .remove(path.join(directory, LOCK_FILE), { force: true })
              .pipe(Effect.ignore)
          )
        );
      });

    const render = (directory: string) =>
      Effect.suspend(() => {
        const key = path.resolve(directory);
        if (inFlight.has(key)) {
          return Effect.void;
        }
        // Claimed before forking and released by the fiber's exit, which
        // also fires for a fiber interrupted before it ran or already done.
        const done = Deferred.makeUnsafe<void>();
        inFlight.set(key, done);
        return renderDirectory(key).pipe(
          Effect.forkIn(scope),
          Effect.tap((fiber) =>
            Effect.sync(() => {
              fiber.addObserver(() => {
                inFlight.delete(key);
                Deferred.doneUnsafe(done, Effect.void);
              });
            })
          ),
          Effect.asVoid
        );
      });

    const status = (directory: string) =>
      Effect.gen(function* readRunVideoStatus() {
        // `run.webm` is renamed into place before the footage is removed;
        // the video is ready once this process has finished with it.
        if (inFlight.has(path.resolve(directory))) {
          return { state: "preparing" } satisfies RunVideoStatus;
        }
        if (yield* exists(path.join(directory, RUN_VIDEO_FILE))) {
          const fallback = yield* fileSystem
            .readFileString(path.join(directory, FALLBACK_FILE))
            .pipe(
              Effect.flatMap(decodeJson(Fallback, "The fallback note")),
              Effect.option
            );
          return Option.match(fallback, {
            onNone: (): RunVideoStatus => ({ condensed: true, state: "ready" }),
            onSome: ({ reason }): RunVideoStatus => ({
              condensed: false,
              reason: reason.trim() || "The video could not be condensed.",
              state: "ready",
            }),
          });
        }
        // The manifest is written only once a Run has ended, so footage
        // without one is still being captured, not waiting for an encode.
        if (yield* exists(path.join(directory, FOOTAGE_MANIFEST_FILE))) {
          yield* render(directory);
          return { state: "preparing" } satisfies RunVideoStatus;
        }
        return { state: "unavailable" } satisfies RunVideoStatus;
      });

    const settled = (directory: string) =>
      Effect.gen(function* awaitRunVideo() {
        const key = path.resolve(directory);
        // Join an existing attempt before recovery can start another one.
        const current = inFlight.get(key);
        if (current !== undefined) {
          yield* Deferred.await(current);
          return;
        }
        if (yield* exists(path.join(key, FOOTAGE_MANIFEST_FILE))) {
          yield* render(key);
        }
        const started = inFlight.get(key);
        if (started !== undefined) {
          yield* Deferred.await(started);
        }
      });

    return RunVideoRenderer.of({ render, settled, status });
  })
);
