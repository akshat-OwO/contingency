import path from "node:path";

import type { RunTraceManifest, RunVideoManifest } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { yauzl } from "playwright-core/lib/utilsBundle";

import {
  canDecodeVideo,
  fixtureServer,
  flow,
  IntegrationLive,
  keyframeCount,
  recordingFrameCount,
  runFlow,
} from "./harness";

/** The EBML magic every WebM file starts with. */
const EBML = "1a45dfa3";

/**
 * Compared as hex rather than as bytes: the formatter rewrites an explicit
 * array conversion into a spread and the comparison silently stops holding.
 */
const leadingHex = (data: Uint8Array, length: number): string =>
  Array.from({ length }, (_unused, index) =>
    (data[index] ?? 0).toString(16).padStart(2, "0")
  ).join("");

const readableTraceContents = (file: string): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    catch: (cause) => new Error(`Could not read Trace: ${String(cause)}`),
    try: async () => {
      const archive = await yauzl.openPromise(file, { lazyEntries: true });
      const contents: string[] = [];
      for await (const entry of archive.eachEntry()) {
        const stream = await archive.openReadStreamPromise(entry);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString("utf-8");
        if (Buffer.from(text, "utf-8").equals(bytes)) {
          contents.push(text);
        }
      }
      return contents.join("\n");
    },
  });

it.live("records a sensitive Playwright Trace by default", () =>
  Effect.gen(function* traceRun() {
    const fileSystem = yield* FileSystem.FileSystem;
    const fixtures = yield* fixtureServer;

    const { directory, persisted } = yield* runFlow(
      flow([
        { type: "navigate", url: fixtures.url("checkout.html") },
        {
          target: [{ kind: "css", selector: "#name" }],
          type: "change",
          value: "Ada Lovelace",
        },
      ])
    );

    expect(persisted.trace).toBe(true);
    expect(persisted.video).toBe(false);

    const manifest = JSON.parse(
      yield* fileSystem.readFileString(path.join(directory, "trace.json"))
    ) as RunTraceManifest;
    expect(manifest.runId).toBe(persisted.runId);
    expect(manifest.containsSecrets).toBe(false);
    expect(manifest.scrubbing).toBe("best-effort");
    expect(manifest.segments).toHaveLength(1);

    const [segment] = manifest.segments;
    expect(segment?.error).toBeUndefined();
    expect(segment?.recorded).toBe(true);
    expect(segment?.file).toBe("attempt-1.trace.zip");

    const bytes = yield* fileSystem.readFile(
      path.join(directory, segment?.file ?? "")
    );
    expect(leadingHex(bytes, 4)).toBe("504b0304");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("can discard the default Trace", () =>
  Effect.gen(function* discardTrace() {
    const fileSystem = yield* FileSystem.FileSystem;
    const fixtures = yield* fixtureServer;
    const { directory, persisted } = yield* runFlow(
      flow([{ type: "navigate", url: fixtures.url("checkout.html") }]),
      { trace: false }
    );

    expect(persisted.trace).toBe(false);
    expect(persisted.video).toBe(false);
    expect(
      (yield* Effect.result(
        fileSystem.readFileString(path.join(directory, "trace.json"))
      ))._tag
    ).toBe("Failure");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("scrubs exact secret values from readable Trace entries", () =>
  Effect.gen(function* scrubSecret() {
    const fixtures = yield* fixtureServer;
    const secret = "correct horse battery staple";
    const authored = flow([
      { type: "navigate", url: fixtures.url("checkout.html") },
      {
        target: [{ kind: "css", selector: "#name" }],
        type: "change",
        value: "{{PASSWORD}}",
      },
    ]);
    Object.assign(authored, {
      variables: [{ name: "PASSWORD", runtime: false, secret: true }],
    });

    const { directory } = yield* runFlow(authored, {
      variables: {
        secretNames: new Set(["PASSWORD"]),
        values: new Map([["PASSWORD", secret]]),
      },
    });
    const trace = yield* readableTraceContents(
      path.join(directory, "attempt-1.trace.zip")
    );

    expect(trace).not.toContain(secret);
    expect(trace).toContain("[REDACTED]");
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live.skipIf(!canDecodeVideo())(
  "derives a playable WebM containing every Step and the settled state",
  () =>
    Effect.gen(function* captureRun() {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtures = yield* fixtureServer;

      const { directory, persisted } = yield* runFlow(
        flow([
          { type: "navigate", url: fixtures.url("checkout.html") },
          {
            target: [{ kind: "css", selector: "#name" }],
            type: "change",
            value: "Ada Lovelace",
          },
          {
            target: [{ kind: "css", selector: "#submit" }],
            type: "click",
          },
        ]),
        { video: true }
      );

      expect(persisted.video).toBe(true);
      expect(persisted.trace).toBe(true);

      const manifest = JSON.parse(
        yield* fileSystem.readFileString(path.join(directory, "video.json"))
      ) as RunVideoManifest;
      expect(manifest.runId).toBe(persisted.runId);
      expect(manifest.containsSecrets).toBe(false);
      expect(manifest.segments).toHaveLength(1);

      const [segment] = manifest.segments;
      expect(segment?.error).toBeUndefined();
      expect(segment?.recorded).toBe(true);
      expect(segment?.file).toBe("attempt-1.webm");
      expect(segment?.steps).toEqual([0, 1, 2]);
      expect(segment?.includesSettledState).toBe(true);

      // Playable, not merely present: a file the encoder never finished is a
      // zero-byte one, which is exactly what a lost recording looks like.
      const bytes = yield* fileSystem.readFile(
        path.join(directory, segment?.file ?? "")
      );
      expect(bytes.length).toBeGreaterThan(1024);
      expect(leadingHex(bytes, 4)).toBe(EBML);

      // Decode the artifact itself: metadata alone cannot prove a Step made it
      // into the video, and the old duration floor could pass on a hollow file.
      const recordingPath = path.join(directory, segment?.file ?? "");
      const frames = yield* recordingFrameCount(recordingPath);
      expect(frames).toBe(4);

      // Every frame is its own keyframe. Audit View seeks to a Step's frame
      // rather than playing to it, and a seek can only land on a keyframe: with
      // one at the start alone, asking for the last Step renders the first.
      expect(yield* keyframeCount(recordingPath)).toBe(frames);
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live.skipIf(!canDecodeVideo())(
  "can derive video without keeping the Trace",
  () =>
    Effect.gen(function* videoWithoutTrace() {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtures = yield* fixtureServer;
      const { directory, persisted } = yield* runFlow(
        flow([{ type: "navigate", url: fixtures.url("checkout.html") }]),
        { trace: false, video: true }
      );

      expect(persisted.trace).toBe(false);
      expect(persisted.video).toBe(true);
      const manifest = JSON.parse(
        yield* fileSystem.readFileString(path.join(directory, "video.json"))
      ) as RunVideoManifest;
      expect(manifest.segments[0]?.recorded).toBe(true);
      expect(
        (yield* Effect.result(
          fileSystem.readFileString(path.join(directory, "trace.json"))
        ))._tag
      ).toBe("Failure");
      expect(
        (yield* Effect.result(
          fileSystem.readFile(path.join(directory, ".attempt-1.trace.zip"))
        ))._tag
      ).toBe("Failure");
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live.skipIf(!canDecodeVideo())(
  "settles a failed attempt before deriving its final frame",
  () =>
    Effect.gen(function* failedAttemptVideo() {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtures = yield* fixtureServer;
      const { directory, persisted } = yield* runFlow(
        flow([
          { type: "navigate", url: fixtures.url("checkout.html") },
          {
            target: [{ kind: "css", selector: "#does-not-exist" }],
            timeout: 100,
            type: "click",
          },
        ]),
        { video: true }
      );

      expect(persisted.outcome).toBe("failed");
      const manifest = JSON.parse(
        yield* fileSystem.readFileString(path.join(directory, "video.json"))
      ) as RunVideoManifest;
      const [segment] = manifest.segments;
      expect(segment?.error).toBeUndefined();
      expect(segment?.recorded).toBe(true);
      expect(segment?.steps).toEqual([0, 1]);
      expect(segment?.includesSettledState).toBe(true);
      expect(
        yield* recordingFrameCount(path.join(directory, segment?.file ?? ""))
      ).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live("still measures Core Web Vitals while capturing the Run to video", () =>
  Effect.gen(function* vitalsUnderCapture() {
    const fixtures = yield* fixtureServer;

    const { persisted } = yield* runFlow(
      flow([
        {
          performance: true,
          type: "navigate",
          url: fixtures.url("checkout.html"),
        },
        {
          target: [{ kind: "css", selector: "#name" }],
          type: "change",
          value: "Ada Lovelace",
        },
      ]),
      { video: true }
    );

    expect(persisted.outcome).toBe("completed");
    const measured = persisted.steps.find((step) => step.vitals !== undefined);
    // The opening navigation is measured like any other Step, including its
    // LCP, which the recorder armed before that navigation ever ran.
    expect(measured?.vitals?.lcp).toBeGreaterThan(0);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
