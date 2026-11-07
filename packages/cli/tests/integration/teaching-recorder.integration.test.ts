import { execFile } from "node:child_process";
import { symlinkSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  AgentSessionId,
  BrowserStreamId,
  makeBrowserRpcError,
  FrameSequence,
  SessionId,
  UserAgentProfileId,
} from "@contingency/protocol";
import type {
  BrowserStreamEvent,
  TeachingStopReason,
} from "@contingency/protocol";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Stream } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { findFfmpeg } from "../../src/services/ffmpeg.ts";
import { makeSessionEvents } from "../../src/services/session-events.ts";
import { emptyDemonstration } from "../../src/services/teaching-demonstration.ts";
import { makeTeachingEncoder } from "../../src/services/teaching-encoder.ts";
import {
  DEFAULT_TEACHING_CAPTURE_LIMITS,
  makeTeachingRecorder,
} from "../../src/services/teaching-recorder.ts";

const executeFile = promisify(execFile);

const liveStatus: BrowserStreamEvent = {
  connected: true,
  screencasting: true,
  type: "status",
  viewportHeight: 720,
  viewportWidth: 1280,
};

const scenarios: readonly {
  readonly name: string;
  readonly reason: TeachingStopReason;
  readonly withFrame: boolean;
}[] = [
  {
    name: "Stop precedes the first screencast frame",
    reason: "user",
    withFrame: false,
  },
  {
    name: "session closure precedes the first screencast frame",
    reason: "session-closed",
    withFrame: false,
  },
  {
    name: "a screencast frame already reached the encoder",
    reason: "user",
    withFrame: true,
  },
];

for (const scenario of scenarios) {
  it.effect(`finalizes a playable recording when ${scenario.name}`, () =>
    Effect.gen(function* stopBeforeFirstFrame() {
      const files = yield* FileSystem.FileSystem;
      const directory = yield* files.makeTempDirectoryScoped();
      const frame = yield* files.readFile(
        new URL("../fixtures/teaching-frame.jpg", import.meta.url).pathname
      );
      const subscribed = yield* Deferred.make<true>();
      const screenshot = vi.fn(() => Promise.resolve(Buffer.from(frame)));
      const event: BrowserStreamEvent = {
        data: frame,
        metadata: {
          deviceHeight: 16,
          deviceWidth: 16,
          offsetTop: 0,
          pageScaleFactor: 1,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          timestamp: 0,
        },
        seq: FrameSequence.make(1),
        streamId: BrowserStreamId.make("teaching-recorder-test"),
        type: "frame",
      };
      const target = {
        context: {
          tracing: {
            start: () =>
              Promise.resolve({
                [Symbol.asyncDispose]: () => Promise.resolve(),
                dispose: () => Promise.resolve(),
              }),
            stop: () => Promise.resolve(),
          },
        },
        page: { url: () => "about:blank" },
      };
      const browser = {
        activeTarget: () => Effect.succeed(target),
        capturePage: () => Effect.promise(screenshot),
        // Like the real stream, lead with the live status. Signal after the
        // consumer has processed all frames supplied here.
        stream: () =>
          Stream.fromIterable<BrowserStreamEvent>(
            scenario.withFrame ? [liveStatus, event] : [liveStatus]
          ).pipe(
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(subscribed, true)).pipe(
                Stream.drain
              )
            ),
            Stream.concat(Stream.never)
          ),
      };
      const recorder = yield* makeTeachingRecorder({
        browser,
        browserSessionId: SessionId.make("create-no-first-frame"),
        counts: () => ({
          actions: 0,
          instructions: 0,
          keyframes: 0,
          urlTransitions: 0,
        }),
        demonstration: emptyDemonstration,
        directory,
        emulation: {
          permissions: [],
          userAgentProfile: UserAgentProfileId.make("default"),
          viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
        },
        fileSystem: files,
        startedAt: new Date().toISOString(),
      });
      yield* Deferred.await(subscribed);
      const result = yield* recorder.stop(
        emptyDemonstration(),
        scenario.reason,
        new Date().toISOString()
      );
      expect(result.failure).toBeUndefined();
      const remuxed = yield* Effect.tryPromise(() =>
        executeFile(
          findFfmpeg(),
          [
            "-loglevel",
            "error",
            "-i",
            path.join(directory, "recording.webm"),
            "-f",
            "webm",
            "-c:v",
            "copy",
            "pipe:1",
          ],
          { encoding: "buffer" }
        )
      );
      expect(remuxed.stdout.byteLength).toBeGreaterThan(0);
      if (scenario.withFrame) {
        expect(screenshot).not.toHaveBeenCalled();
      } else {
        expect(screenshot).toHaveBeenCalledOnce();
      }
    }).pipe(Effect.provide(NodeServices.layer))
  );
}

it.effect("starts recording only once its screencast is live", () =>
  Effect.gen(function* awaitLiveCapture() {
    const files = yield* FileSystem.FileSystem;
    const directory = yield* files.makeTempDirectoryScoped();
    const frame = yield* files.readFile(
      new URL("../fixtures/teaching-frame.jpg", import.meta.url).pathname
    );
    const opened = yield* Deferred.make<true>();
    const live = yield* Deferred.make<true>();
    const target = {
      context: {
        tracing: {
          start: () =>
            Promise.resolve({
              [Symbol.asyncDispose]: () => Promise.resolve(),
              dispose: () => Promise.resolve(),
            }),
          stop: () => Promise.resolve(),
        },
      },
      page: {
        url: () => "about:blank",
      },
    };
    const browser = {
      activeTarget: () => Effect.succeed(target),
      capturePage: () => Effect.succeed(Buffer.from(frame)),
      // The status arrives only once the test says the screencast started.
      stream: () =>
        Stream.fromEffect(
          Deferred.succeed(opened, true).pipe(
            Effect.andThen(Deferred.await(live)),
            Effect.as(liveStatus)
          )
        ).pipe(Stream.concat(Stream.never)),
    };
    const starting = yield* makeTeachingRecorder({
      browser,
      browserSessionId: SessionId.make("create-live-capture"),
      counts: () => ({
        actions: 0,
        instructions: 0,
        keyframes: 0,
        urlTransitions: 0,
      }),
      demonstration: emptyDemonstration,
      directory,
      emulation: {
        permissions: [],
        userAgentProfile: UserAgentProfileId.make("default"),
        viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
      },
      fileSystem: files,
      startedAt: new Date().toISOString(),
    }).pipe(Effect.forkChild);
    yield* Deferred.await(opened).pipe(Effect.timeout("30 seconds"));
    expect(starting.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(live, true);
    const recorder = yield* Fiber.join(starting).pipe(
      Effect.timeout("30 seconds")
    );
    const result = yield* recorder.stop(
      emptyDemonstration(),
      "user",
      new Date().toISOString()
    );
    expect(result.failure).toBeUndefined();
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("fails Start when its screencast fails before going live", () =>
  Effect.gen(function* failBeforeLive() {
    const files = yield* FileSystem.FileSystem;
    const directory = yield* files.makeTempDirectoryScoped();
    const refused = makeBrowserRpcError(
      "stream_failed",
      "Could not start the canvas stream"
    );
    const target = {
      context: {
        tracing: {
          start: () =>
            Promise.resolve({
              [Symbol.asyncDispose]: () => Promise.resolve(),
              dispose: () => Promise.resolve(),
            }),
          stop: () => Promise.resolve(),
        },
      },
      page: {
        url: () => "about:blank",
      },
    };
    const started = yield* Effect.flip(
      makeTeachingRecorder({
        browser: {
          activeTarget: () => Effect.succeed(target),
          capturePage: () =>
            Effect.fail(
              makeBrowserRpcError(
                "agent_browser_failed",
                "Start never went live."
              )
            ),
          stream: () => Stream.fail(refused),
        },
        browserSessionId: SessionId.make("create-refused-capture"),
        counts: () => ({
          actions: 0,
          instructions: 0,
          keyframes: 0,
          urlTransitions: 0,
        }),
        demonstration: emptyDemonstration,
        directory,
        emulation: {
          permissions: [],
          userAgentProfile: UserAgentProfileId.make("default"),
          viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
        },
        fileSystem: files,
        startedAt: new Date().toISOString(),
      })
    );
    expect(started).toBe(refused);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "warns once on output budget and stops only at the output hard cap",
  () =>
    Effect.gen(function* outputBudget() {
      const events = makeSessionEvents();
      const id = AgentSessionId.make("agent-output-budget");
      const before = yield* events.read(id);
      const files = yield* FileSystem.FileSystem;
      const directory = yield* files.makeTempDirectoryScoped();
      const frame = yield* files.readFile(
        new URL("../fixtures/teaching-frame.jpg", import.meta.url).pathname
      );
      const subscribed = yield* Deferred.make<true>();
      const screenshot = vi.fn(() => Promise.resolve(Buffer.from(frame)));
      const target = {
        context: {
          tracing: {
            start: () =>
              Promise.resolve({
                [Symbol.asyncDispose]: () => Promise.resolve(),
                dispose: () => Promise.resolve(),
              }),
            stop: () => Promise.resolve(),
          },
        },
        page: { url: () => "about:blank" },
      };
      const browser = {
        activeTarget: () => Effect.succeed(target),
        capturePage: () => Effect.promise(screenshot),
        // Like the real stream, lead with the live status. Signal after the
        // consumer has processed all frames supplied here.
        stream: () =>
          Stream.fromIterable<BrowserStreamEvent>([liveStatus]).pipe(
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(subscribed, true)).pipe(
                Stream.drain
              )
            ),
            Stream.concat(Stream.never)
          ),
      };
      const recorder = yield* makeTeachingRecorder({
        browser,
        browserSessionId: SessionId.make("create-no-first-frame"),
        counts: () => ({
          actions: 0,
          instructions: 0,
          keyframes: 0,
          urlTransitions: 0,
        }),
        demonstration: emptyDemonstration,
        directory,
        emulation: {
          permissions: [],
          userAgentProfile: UserAgentProfileId.make("default"),
          viewport: { deviceScaleFactor: 1, height: 720, width: 1280 },
        },
        fileSystem: files,
        limits: {
          ...DEFAULT_TEACHING_CAPTURE_LIMITS,
          videoBudgetBytes: 1024 * 1024,
          videoHardCapBytes: 3 * 1024 * 1024,
        },
        onVideoBudgetExceeded: (message) =>
          events.recordingBudgetExceeded(id, message),
        startedAt: new Date().toISOString(),
      });
      yield* Deferred.await(subscribed);

      const video = path.join(directory, "recording.webm");
      writeFileSync(video, "");
      truncateSync(video, 2 * 1024 * 1024);
      yield* TestClock.adjust(1000);
      const first = yield* events.read(id, before.eventCursor);
      expect(first.events).toHaveLength(1);
      expect(first.events[0]?.kind).toBe("teaching-recording-budget-exceeded");
      expect(first.events[0]?.name).toContain(
        "agent_teaching_recording_discard"
      );
      yield* TestClock.adjust(1000);
      expect((yield* events.read(id, first.eventCursor)).events).toHaveLength(
        0
      );
      const limit = yield* recorder.limitReached.pipe(Effect.forkChild);
      expect(limit.pollUnsafe()).toBeUndefined();
      truncateSync(video, 4 * 1024 * 1024);
      yield* TestClock.adjust(1000);
      expect(yield* Fiber.join(limit)).toContain(
        "4 MiB exceeds the hard limit of 3 MiB"
      );
      truncateSync(video, 0);
      yield* recorder.stop(
        emptyDemonstration(),
        "limit-reached",
        new Date().toISOString()
      );
    }).pipe(Effect.provide(NodeServices.layer))
);

it.effect("does not charge input frame bytes against the output cap", () =>
  Effect.gen(function* inputBytes() {
    const files = yield* FileSystem.FileSystem;
    const directory = yield* files.makeTempDirectoryScoped();
    const frame = yield* files.readFile(
      new URL("../fixtures/teaching-frame.jpg", import.meta.url).pathname
    );
    const encoder = yield* makeTeachingEncoder({
      maxBytes: 1,
      output: path.join(directory, "recording.webm"),
    });
    expect(frame.byteLength).toBeGreaterThan(1);
    yield* encoder.write(frame);
    expect(yield* encoder.hasFrames).toBe(true);
  }).pipe(Effect.provide(NodeServices.layer))
);

it.effect(
  "keeps the last output measurement after a transient stat failure",
  () =>
    Effect.gen(function* statFailure() {
      const files = yield* FileSystem.FileSystem;
      const directory = yield* files.makeTempDirectoryScoped();
      const output = path.join(directory, "recording.webm");
      const encoder = yield* makeTeachingEncoder({ maxBytes: 1024, output });
      writeFileSync(output, "measured");
      expect(yield* encoder.bytesWritten).toBe(8);
      unlinkSync(output);
      symlinkSync(output, output);
      expect(yield* encoder.bytesWritten).toBe(8);
      expect(yield* encoder.failure).toBeUndefined();
      unlinkSync(output);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
