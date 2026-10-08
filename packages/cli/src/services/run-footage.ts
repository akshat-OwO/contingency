import path from "node:path";

import { RunVideoFastForward } from "@contingency/protocol";
import type { SessionId, Viewport } from "@contingency/protocol";
import { Effect, Fiber, Schema, Stream } from "effect";
import type { Scope, FileSystem } from "effect";

import type { CreateBrowserService } from "./create-browser-contract.ts";
import { RUN_VIDEO_FRAME_MS } from "./run-video-plan.ts";
import { makeTimedVideoEncoder } from "./timed-video-encoder.ts";

/** The real-time recording a Run's video is condensed from. */
export const FOOTAGE_VIDEO_FILE = "footage.webm";
/** Everything besides the frames that the condensed video needs. */
export const FOOTAGE_MANIFEST_FILE = "footage.json";

const RunSpanSchema = Schema.Struct({
  fromMs: Schema.Finite,
  toMs: Schema.Finite,
});

/**
 * What a Run's capture leaves for its video: when it started, where each
 * frame sits, where the agent pointed, and when the agent acted or a person
 * held the browser. Offsets count from the first frame, which the footage
 * shows at zero.
 */
export const FootageManifest = Schema.Struct({
  actions: Schema.Array(RunSpanSchema),
  durationMs: Schema.Finite,
  fastForward: RunVideoFastForward,
  /** The offset of every frame in the footage, ascending. */
  frames: Schema.Array(Schema.Finite),
  height: Schema.Int,
  pointers: Schema.Array(
    Schema.Struct({
      action: Schema.Literals(["click", "move"]),
      atMs: Schema.Finite,
      durationMs: Schema.Finite,
      x: Schema.Finite,
      y: Schema.Finite,
    })
  ),
  /** Epoch milliseconds of offset zero. */
  startedAt: Schema.Finite,
  takeovers: Schema.Array(RunSpanSchema),
  version: Schema.Literal(1),
  width: Schema.Int,
});
export type FootageManifest = typeof FootageManifest.Type;

export interface RunFootage {
  /** One Action Window, in epoch milliseconds. */
  readonly markAction: (startedAt: number, endedAt: number) => void;
  /** Who holds the browser from `at`, in epoch milliseconds. */
  readonly markController: (controller: "agent" | "user", at: number) => void;
  /**
   * The manifest the capture left behind, once its scope has closed; absent
   * while capturing, or when nothing playable was captured.
   */
  readonly manifest: () => FootageManifest | undefined;
}

export interface RunFootageOptions {
  readonly browser: CreateBrowserService;
  readonly browserSessionId: SessionId;
  readonly directory: string;
  readonly fastForward: RunVideoFastForward;
  readonly fileSystem: FileSystem.FileSystem;
  readonly viewport: Viewport;
}

/** VP9 wants even dimensions. */
const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);

interface Projection {
  readonly deviceHeight: number;
  readonly deviceWidth: number;
  readonly offsetTop: number;
  readonly pageScaleFactor: number;
}

/**
 * Record a Run as it happens, from the same screencast the Workspace shows:
 * each frame keeps the moment Chromium painted it, so the agent's pointer and
 * its actions line up with the footage exactly. Frames are thinned to the
 * video's frame rate and encoded live, so a long Run costs VP9 bytes rather
 * than JPEG bytes. Capture never fails the Run: a Run without video is still
 * a Run, so a capture that cannot start leaves none.
 */
export const makeRunFootage = (
  options: RunFootageOptions
): Effect.Effect<RunFootage | undefined, never, Scope.Scope> =>
  Effect.gen(function* startRunFootage() {
    const { fileSystem } = options;
    const width = even(options.viewport.width);
    const height = even(options.viewport.height);
    const videoFile = path.join(options.directory, FOOTAGE_VIDEO_FILE);
    const started = yield* Effect.result(
      makeTimedVideoEncoder({
        height,
        label: "Run footage",
        lossy: true,
        output: videoFile,
        width,
      })
    );
    if (started._tag === "Failure") {
      yield* Effect.logWarning(started.failure.message);
      return;
    }
    const encoder = started.success;
    const startedAt = Date.now();
    const offset = (epochMs: number) => Math.max(0, epochMs - startedAt);

    const frames: number[] = [];
    const pointers: FootageManifest["pointers"][number][] = [];
    const actions: FootageManifest["actions"][number][] = [];
    const takeovers: FootageManifest["takeovers"][number][] = [];
    let takeoverFrom: number | undefined;
    let projection: Projection | undefined;
    // The frame waiting for its slot, and the last one written: a burst of
    // repaints keeps only its latest frame per slot, and the last frame is
    // shown again at the end so the footage lasts as long as the Run.
    let pending: { data: Uint8Array; atMs: number } | undefined;
    let written: { data: Uint8Array; atMs: number } | undefined;
    let manifest: FootageManifest | undefined;

    const writeFrame = (frame: { data: Uint8Array; atMs: number }) => {
      // The first frame is the footage's zero, whenever it was painted.
      const atMs =
        written === undefined ? 0 : Math.max(frame.atMs, written.atMs + 1);
      written = { atMs, data: frame.data };
      frames.push(atMs);
      return encoder.write(frame.data, atMs);
    };

    const capture = yield* options.browser
      .stream(options.browserSessionId)
      .pipe(
        Stream.runForEach((event) => {
          if (event.type === "agent_pointer") {
            if (projection === undefined) {
              return Effect.void;
            }
            const scaleX = width / projection.deviceWidth;
            const scaleY = height / projection.deviceHeight;
            pointers.push({
              action: event.action,
              atMs: offset(event.timestamp),
              durationMs: event.durationMs,
              x: event.x * projection.pageScaleFactor * scaleX,
              y:
                (event.y * projection.pageScaleFactor + projection.offsetTop) *
                scaleY,
            });
            return Effect.void;
          }
          if (event.type !== "frame") {
            return Effect.void;
          }
          const { metadata } = event;
          if (metadata.deviceWidth > 0 && metadata.deviceHeight > 0) {
            projection = metadata;
          }
          const frame = {
            atMs: offset(metadata.timestamp * 1000),
            data: event.data,
          };
          const previous = pending;
          pending = frame;
          if (
            previous !== undefined &&
            Math.floor(previous.atMs / RUN_VIDEO_FRAME_MS) !==
              Math.floor(frame.atMs / RUN_VIDEO_FRAME_MS)
          ) {
            return writeFrame(previous);
          }
          return Effect.void;
        }),
        Effect.tapError((cause) =>
          Effect.logWarning(`Run footage stopped: ${cause.message}`)
        ),
        Effect.ignore,
        Effect.forkDetach
      );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* finishRunFootage() {
        yield* Fiber.interrupt(capture);
        const endedAt = Date.now();
        if (takeoverFrom !== undefined) {
          takeovers.push({ fromMs: takeoverFrom, toMs: offset(endedAt) });
          takeoverFrom = undefined;
        }
        if (pending !== undefined) {
          yield* writeFrame(pending);
          pending = undefined;
        }
        const last = written;
        const durationMs = offset(endedAt);
        if (last !== undefined && durationMs > last.atMs) {
          yield* writeFrame({ atMs: durationMs, data: last.data });
        }
        const failure = yield* encoder.finish;
        if (failure !== undefined || last === undefined) {
          if (failure !== undefined) {
            yield* Effect.logWarning(failure);
          }
          yield* fileSystem
            .remove(videoFile, { force: true })
            .pipe(Effect.ignore);
          return;
        }
        const captured: FootageManifest = {
          actions,
          durationMs: Math.max(durationMs, written?.atMs ?? 0),
          fastForward: options.fastForward,
          frames,
          height,
          pointers,
          startedAt,
          takeovers,
          version: 1,
          width,
        };
        const saved = yield* Effect.result(
          fileSystem.writeFileString(
            path.join(options.directory, FOOTAGE_MANIFEST_FILE),
            JSON.stringify(Schema.encodeSync(FootageManifest)(captured)),
            { mode: 0o600 }
          )
        );
        if (saved._tag === "Failure") {
          yield* Effect.logWarning(
            `Could not save the Run footage manifest: ${saved.failure.message}`
          );
          return;
        }
        manifest = captured;
      })
    );

    return {
      manifest: () => manifest,
      markAction: (actionStartedAt, actionEndedAt) => {
        actions.push({
          fromMs: offset(actionStartedAt),
          toMs: offset(actionEndedAt),
        });
      },
      markController: (controller, at) => {
        if (controller === "user" && takeoverFrom === undefined) {
          takeoverFrom = offset(at);
        } else if (controller === "agent" && takeoverFrom !== undefined) {
          takeovers.push({ fromMs: takeoverFrom, toMs: offset(at) });
          takeoverFrom = undefined;
        }
      },
    };
  });
