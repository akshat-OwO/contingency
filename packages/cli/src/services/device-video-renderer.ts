import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { DeviceVideoCapture } from "@contingency/protocol";
import type { DeviceVideoStatus } from "@contingency/protocol";
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
  captureFacts,
  DEVICE_CAPTURE_FILE,
  DEVICE_VIDEO_FILE,
  readDeviceCapture,
} from "./device-video-capture.ts";
import type { DeviceCaptureManifest } from "./device-video-capture.ts";
import { deviceCompositorPage } from "./device-video-compositor-page.ts";
import type { DeviceCompositorFrame } from "./device-video-compositor-page.ts";
import {
  chunkStarts,
  deviceFrameAt,
  deviceVideoCapture,
  deviceVideoSegments,
  deviceVideoSize,
  deviceVideoTimeMap,
} from "./device-video-plan.ts";
import type { DeviceFootageChunk } from "./device-video-plan.ts";
import { readMp4Frames } from "./mp4-frames.ts";
import { processExists } from "./process-liveness.ts";
import {
  fastForwardLabel,
  RUN_VIDEO_FRAME_MS,
  runOffsetAtVideo,
  runVideoDurationMs,
  segmentAtVideo,
} from "./run-video-plan.ts";
import { makeTimedVideoEncoder } from "./timed-video-encoder.ts";

const execute = promisify(execFile);

const PARTIAL_FILE = "video.partial.webm";
const LOCK_FILE = "render.lock";
/** Written when the raw footage stands in for the rendered video. */
const FALLBACK_FILE = "fallback.json";
/** What the footage covered, saved once rendering has read it. */
const COVERAGE_FILE = "coverage.json";
/** Footage decoded into H.264 for the compositor, beside its source. */
const DECODED_SUFFIX = ".h264.mp4";

const COMPOSITOR_ORIGIN = "http://device-video.contingency.invalid";
const FOOTAGE_CHUNK_BYTES = 4 * 1024 * 1024;
const FRAME_TIMEOUT = "30 seconds";
/** macOS's own converter, which decodes the simulator's HEVC. */
const AVCONVERT = "/usr/bin/avconvert";

const Fallback = Schema.fromJsonString(
  Schema.Struct({ reason: Schema.String })
);
const Coverage = Schema.fromJsonString(
  Schema.Struct({ capture: DeviceVideoCapture })
);

export interface DeviceVideoRendererService {
  /** Render a capture folder's footage into its video, in the background. */
  readonly render: (folder: string) => Effect.Effect<void>;
  /**
   * Where a capture folder's video stands. `live` says the session that owns
   * it is still recording, so an unfinished record is not an interrupted one.
   */
  readonly status: (
    folder: string,
    live: boolean
  ) => Effect.Effect<DeviceVideoStatus>;
  /** Wait for this process's render of the folder, if one is under way. */
  readonly settled: (folder: string) => Effect.Effect<void>;
}

export const DeviceVideoRenderer = Context.Service<DeviceVideoRendererService>(
  "@contingency/DeviceVideoRenderer"
);

const failure = (message: string) => new Error(message);

const rounded = (value: number): number => Math.round(value * 1000) / 1000;

const isHevc = (codec: string) => codec === "hvc1" || codec === "hev1";

export const DeviceVideoRendererLive = Layer.effect(
  DeviceVideoRenderer,
  Effect.gen(function* makeDeviceVideoRenderer() {
    const fileSystem = yield* FileSystem.FileSystem;
    const browser = yield* CreateBrowser;
    const scope = yield* Effect.scope;
    const inFlight = new Map<string, Deferred.Deferred<true>>();

    const exists = (file: string) =>
      fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));

    const acquireLock = (folder: string): Effect.Effect<boolean> =>
      Effect.gen(function* lockDeviceVideo() {
        const file = path.join(folder, LOCK_FILE);
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
          if (Number.isInteger(holder) && holder > 0 && processExists(holder)) {
            return false;
          }
          yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
        }
        return false;
      });

    const serveFootage = (page: Page, files: readonly string[], html: string) =>
      tryBrowser("Could not prepare the device video compositor", () =>
        page.route(`${COMPOSITOR_ORIGIN}/**`, async (route) => {
          const url = new URL(route.request().url());
          const match = /^\/footage\/(?<index>\d+)$/u.exec(url.pathname);
          if (match === null) {
            await route.fulfill({ body: html, contentType: "text/html" });
            return;
          }
          const footage = files[Number(match.groups?.index)];
          if (footage === undefined) {
            await route.fulfill({ status: 404 });
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
          // Seeking needs ranges; a whole-file answer leaves the element
          // unable to present a sought frame.
          await route.fulfill({
            body: Buffer.from(body),
            headers: {
              "accept-ranges": "bytes",
              "content-range": `bytes ${start}-${end}/${size}`,
              "content-type": "video/mp4",
            },
            status: 206,
          });
        })
      );

    const composeFrame = (page: Page, frame: DeviceCompositorFrame) =>
      tryBrowser("Could not draw a device video frame", () =>
        page.evaluate<unknown>(`window.composeFrame(${JSON.stringify(frame)})`)
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
        Effect.timeoutOrElse({
          duration: FRAME_TIMEOUT,
          orElse: () =>
            Effect.fail(failure("Drawing a device video frame took too long.")),
        }),
        Effect.flatMap((dataUrl) => {
          const comma = dataUrl.indexOf(",");
          return comma === -1
            ? Effect.fail(failure("A device video frame came back empty."))
            : Effect.succeed(Buffer.from(dataUrl.slice(comma + 1), "base64"));
        })
      );

    /** Footage the compositor can decode: the simulator's HEVC becomes H.264. */
    const decodable = (file: string) =>
      Effect.gen(function* decodableFootage() {
        const frames = yield* readMp4Frames(file).pipe(
          Effect.mapError((cause) => failure(cause.message))
        );
        if (!isHevc(frames.codec)) {
          return { file, frames };
        }
        const decoded = `${file}${DECODED_SUFFIX}`;
        if (!(yield* exists(decoded))) {
          yield* Effect.tryPromise({
            catch: () =>
              failure(
                "The simulator's HEVC footage could not be converted for rendering."
              ),
            try: (signal) =>
              execute(
                AVCONVERT,
                [
                  "--source",
                  file,
                  "--output",
                  `${decoded}.tmp.mp4`,
                  "--preset",
                  "Preset1920x1080",
                  "--replace",
                ],
                { signal, timeout: 30 * 60_000 }
              ),
          });
          yield* fileSystem
            .rename(`${decoded}.tmp.mp4`, decoded)
            .pipe(Effect.mapError((cause) => failure(cause.message)));
        }
        return {
          file: decoded,
          frames: yield* readMp4Frames(decoded).pipe(
            Effect.mapError((cause) => failure(cause.message))
          ),
        };
      });

    const removeFootage = (folder: string, manifest: DeviceCaptureManifest) =>
      Effect.forEach(
        [
          ...manifest.files.flatMap((name) => [
            name,
            `${name}${DECODED_SUFFIX}`,
          ]),
          PARTIAL_FILE,
        ],
        (name) =>
          fileSystem
            .remove(path.join(folder, name), { force: true })
            .pipe(Effect.ignore),
        { discard: true }
      );

    const render = (folder: string, manifest: DeviceCaptureManifest) =>
      Effect.scoped(
        Effect.gen(function* renderDeviceVideo() {
          const facts = captureFacts(manifest);
          if (facts === undefined) {
            return yield* Effect.fail(
              failure("The recording was never finalized.")
            );
          }
          const sources: { file: string; frames: DeviceFootageChunk }[] = [];
          const starts = manifest.starts ?? chunkStarts(manifest.files.length);
          for (const [index, name] of manifest.files.entries()) {
            const read = yield* decodable(path.join(folder, name));
            sources.push({
              file: read.file,
              frames: {
                durationMs: read.frames.durationMs,
                frames: read.frames.frames,
                height: read.frames.height,
                startMs: starts[index] ?? 0,
                width: read.frames.width,
              },
            });
          }
          const chunks = sources.map((source) => source.frames);
          const capture = deviceVideoCapture(facts, chunks);
          yield* fileSystem
            .writeFileString(
              path.join(folder, COVERAGE_FILE),
              Schema.encodeSync(Coverage)({ capture }),
              { mode: 0o600 }
            )
            .pipe(Effect.mapError((cause) => failure(cause.message)));
          const size = deviceVideoSize(chunks);
          const segments = deviceVideoSegments(facts);
          const durationMs = runVideoDurationMs(segments);
          const page = yield* browser.compositor(size);
          yield* serveFootage(
            page,
            sources.map((source) => source.file),
            deviceCompositorPage(size.width, size.height)
          );
          yield* tryBrowser("Could not open the device video compositor", () =>
            page.goto(`${COMPOSITOR_ORIGIN}/`)
          );
          const encoder = yield* makeTimedVideoEncoder({
            height: size.height,
            label: "Device video",
            lossy: false,
            output: path.join(folder, PARTIAL_FILE),
            width: size.width,
          });
          const count = Math.max(1, Math.ceil(durationMs / RUN_VIDEO_FRAME_MS));
          let previous: { jpeg: Buffer; key: string } | undefined;
          for (let index = 0; index <= count; index += 1) {
            const videoMs = Math.min(index * RUN_VIDEO_FRAME_MS, durationMs);
            const runMs = runOffsetAtVideo(segments, videoMs);
            const shown = deviceFrameAt(chunks, capture, runMs);
            const segment = segmentAtVideo(segments, videoMs);
            const drawn: DeviceCompositorFrame = {
              badge:
                segment?.kind === "idle-gap"
                  ? fastForwardLabel(segment.rate)
                  : null,
              card: shown.kind === "footage" ? null : shown.kind,
              chunk: shown.kind === "footage" ? shown.chunk : null,
              gap: shown.kind === "footage" && shown.gap,
              seek: shown.kind === "footage" ? rounded(shown.seek) : 0,
            };
            const key = JSON.stringify([
              shown.kind === "footage"
                ? [shown.chunk, shown.frame]
                : shown.kind,
              drawn.gap,
              drawn.badge,
            ]);
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

    /**
     * Keep the raw footage as the video and say why. It is deleted only once
     * it has stood in, so a failure leaves it for a later attempt.
     */
    const fallBack = (folder: string, reason: string) =>
      Effect.gen(function* keepRawFootage() {
        yield* Effect.logWarning(`Device video kept as recorded: ${reason}`);
        yield* fileSystem
          .remove(path.join(folder, PARTIAL_FILE), { force: true })
          .pipe(Effect.ignore);
        yield* fileSystem
          .writeFileString(
            path.join(folder, FALLBACK_FILE),
            Schema.encodeSync(Fallback)({ reason }),
            { mode: 0o600 }
          )
          .pipe(Effect.ignore);
      });

    /** Cleanup deletes the capture record; footage without it is not kept. */
    const purgedMeanwhile = (folder: string) =>
      exists(path.join(folder, DEVICE_CAPTURE_FILE)).pipe(
        Effect.map((present) => !present)
      );

    const renderFolder = (folder: string) =>
      Effect.gen(function* renderLocked() {
        if (!(yield* acquireLock(folder))) {
          return;
        }
        yield* Effect.gen(function* renderWithLock() {
          const manifest = yield* readDeviceCapture(folder);
          if (manifest?.state !== "recorded") {
            return;
          }
          if (yield* exists(path.join(folder, DEVICE_VIDEO_FILE))) {
            yield* removeFootage(folder, manifest);
            return;
          }
          if (yield* exists(path.join(folder, FALLBACK_FILE))) {
            return;
          }
          const rendered = yield* Effect.result(render(folder, manifest));
          if (rendered._tag === "Failure") {
            yield* fallBack(folder, rendered.failure.message);
            return;
          }
          if (yield* purgedMeanwhile(folder)) {
            yield* removeFootage(folder, manifest);
            return;
          }
          const renamed = yield* Effect.result(
            fileSystem.rename(
              path.join(folder, PARTIAL_FILE),
              path.join(folder, DEVICE_VIDEO_FILE)
            )
          );
          if (renamed._tag === "Failure") {
            yield* fallBack(folder, renamed.failure.message);
            return;
          }
          if (yield* purgedMeanwhile(folder)) {
            yield* fileSystem
              .remove(path.join(folder, DEVICE_VIDEO_FILE), { force: true })
              .pipe(Effect.ignore);
          }
          // One video per recording: the raw footage goes once it is encoded.
          yield* removeFootage(folder, manifest);
        }).pipe(
          Effect.ensuring(
            fileSystem
              .remove(path.join(folder, LOCK_FILE), { force: true })
              .pipe(Effect.ignore)
          )
        );
      });

    const renderInBackground = (folder: string) =>
      Effect.suspend(() => {
        const key = path.resolve(folder);
        if (inFlight.has(key)) {
          return Effect.void;
        }
        const done = Deferred.makeUnsafe<true>();
        inFlight.set(key, done);
        return renderFolder(key).pipe(
          Effect.forkIn(scope),
          Effect.tap((fiber) =>
            Effect.sync(() => {
              fiber.addObserver(() => {
                inFlight.delete(key);
                Deferred.doneUnsafe(done, Effect.succeed(true));
              });
            })
          ),
          Effect.asVoid
        );
      });

    const coverage = (folder: string) =>
      fileSystem.readFileString(path.join(folder, COVERAGE_FILE)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Coverage)),
        Effect.map((value) => value.capture),
        Effect.option
      );

    const status = (folder: string, live: boolean) =>
      Effect.gen(function* readDeviceVideoStatus() {
        const key = path.resolve(folder);
        const manifest = yield* readDeviceCapture(key);
        if (manifest === undefined) {
          return {
            reason:
              "This session kept no video. Sessions recorded before device video existed have screens only.",
            state: "not-recorded",
          } satisfies DeviceVideoStatus;
        }
        if (manifest.state === "not-recorded") {
          return {
            reason: `No video was recorded. ${manifest.reason ?? "The device's screen recorder did not start."}`,
            state: "not-recorded",
          } satisfies DeviceVideoStatus;
        }
        if (manifest.state === "recording") {
          return live
            ? ({ state: "preparing" } satisfies DeviceVideoStatus)
            : ({
                directory: key,
                reason:
                  "The recording was interrupted before it was finalized, so its footage was not kept.",
                state: "unavailable",
              } satisfies DeviceVideoStatus);
        }
        if (manifest.state === "failed") {
          return {
            directory: key,
            reason: manifest.reason ?? "The device's footage was not kept.",
            state: "unavailable",
          } satisfies DeviceVideoStatus;
        }
        if (inFlight.has(key)) {
          return { state: "preparing" } satisfies DeviceVideoStatus;
        }
        const facts = captureFacts(manifest);
        if (facts === undefined) {
          return {
            directory: key,
            reason: "The recording was never finalized.",
            state: "unavailable",
          } satisfies DeviceVideoStatus;
        }
        const captured = yield* coverage(key);
        const video = path.join(key, DEVICE_VIDEO_FILE);
        if (yield* exists(video)) {
          return {
            capture: Option.getOrElse(captured, () =>
              deviceVideoCapture(facts, [])
            ),
            pacing: manifest.pacing,
            path: video,
            state: "ready",
            timeMap: deviceVideoTimeMap(facts),
          } satisfies DeviceVideoStatus;
        }
        const [first] = manifest.files;
        const raw = first === undefined ? undefined : path.join(key, first);
        const fallback = yield* fileSystem
          .readFileString(path.join(key, FALLBACK_FILE))
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Fallback)),
            Effect.option
          );
        if (raw !== undefined && (yield* exists(raw))) {
          if (Option.isSome(fallback)) {
            const more =
              manifest.files.length > 1
                ? " Only its first part, about 3 minutes, plays here."
                : "";
            return {
              capture: Option.getOrElse(captured, () =>
                deviceVideoCapture(facts, [])
              ),
              fallback: `${fallback.value.reason.trim() || "The video could not be rendered."} Playing the raw recording.${more}`,
              pacing: "real-time",
              path: raw,
              state: "ready",
              timeMap: deviceVideoTimeMap({ ...facts, pacing: "real-time" }),
            } satisfies DeviceVideoStatus;
          }
          yield* renderInBackground(key);
          return { state: "preparing" } satisfies DeviceVideoStatus;
        }
        return {
          capture: Option.getOrUndefined(captured),
          directory: key,
          reason:
            "The video file is no longer in this session's folder. It was deleted or moved after the session ended.",
          state: "unavailable",
        } satisfies DeviceVideoStatus;
      });

    const settled = (folder: string) =>
      Effect.gen(function* awaitDeviceVideo() {
        const current = inFlight.get(path.resolve(folder));
        if (current !== undefined) {
          yield* Deferred.await(current);
        }
      });

    const provided = <A, E>(
      effect: Effect.Effect<A, E, FileSystem.FileSystem>
    ): Effect.Effect<A, E> =>
      Effect.provideService(effect, FileSystem.FileSystem, fileSystem);

    return DeviceVideoRenderer.of({
      render: (folder) => provided(renderInBackground(folder)),
      settled,
      status: (folder, live) => provided(status(folder, live)),
    });
  })
);
