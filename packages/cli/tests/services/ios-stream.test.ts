import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { verifyIosForegroundRelease } from "../../src/services/ios-foreground-release.ts";
import { verifyIosFramebufferRelease } from "../../src/services/ios-framebuffer-release.ts";
import {
  IosFramebufferPacket,
  makeIosStreamIntegrity,
} from "../../src/services/ios-stream-integrity.ts";

const packet = (sequence: number): IosFramebufferPacket => ({
  displayPort: "11111111-1111-1111-1111-111111111111",
  encodedMs: sequence * 10 + 2,
  height: 1500,
  jpeg: "/9j/",
  presentedMs: 0,
  sampledMs: sequence * 10,
  sequence,
  sourceSequence: 0,
  startMs: 1,
  width: 720,
});

it.effect("retains only the Start-to-Stop interval on a static display", () =>
  Effect.gen(function* captureInterval() {
    const capture = makeIosStreamIntegrity();
    yield* capture.generation("one");
    expect(yield* capture.start(0)).toBe(false);
    expect(yield* capture.accept("one", packet(1))).toBe(true);
    expect(capture.snapshot()).toBe(null);
    expect(yield* capture.start(0)).toBe(true);
    expect(yield* capture.accept("one", packet(2))).toBe(true);
    expect(yield* capture.accept("one", packet(3))).toBe(true);
    const stopped = yield* capture.stop();
    expect(stopped).toEqual({
      firstSampledMs: 20,
      firstSequence: 2,
      gaps: [],
      generation: "one",
      lastSampledMs: 30,
      lastSequence: 3,
      sampledAfterMs: 0,
      status: "stopped",
    });
    expect(yield* capture.accept("one", packet(4))).toBe(true);
    expect(capture.snapshot()).toEqual(stopped);
    yield* capture.fail("helper-exited");
    expect(capture.snapshot()).toEqual(stopped);
  })
);

it.effect(
  "a restarted helper cannot repair or inject into the old interval",
  () =>
    Effect.gen(function* restartCapture() {
      const capture = makeIosStreamIntegrity();
      yield* capture.generation("one");
      yield* capture.accept("one", packet(1));
      yield* capture.start(0);
      yield* capture.accept("one", packet(2));
      yield* capture.generation("two");
      expect(yield* capture.accept("one", packet(3))).toBe(false);
      expect(yield* capture.accept("two", packet(1))).toBe(true);
      expect(yield* capture.stop()).toMatchObject({
        firstSequence: 2,
        gaps: ["source-reset"],
        generation: "one",
        lastSequence: 2,
        status: "incomplete",
      });
    })
);

it.effect("refuses output loss, callback resets, and invalid times", () =>
  Effect.gen(function* rejectDiscontinuities() {
    const cases = [
      { changed: packet(3), gap: "sequence-gap" },
      { changed: { ...packet(2), sourceSequence: 0 }, gap: "source-reset" },
      { changed: { ...packet(2), encodedMs: 19 }, gap: "invalid-packet" },
    ];
    for (const { changed, gap } of cases) {
      const capture = makeIosStreamIntegrity();
      yield* capture.generation("one");
      yield* capture.accept("one", {
        ...packet(1),
        sourceSequence: gap === "source-reset" ? 1 : 0,
      });
      yield* capture.start(0);
      expect(yield* capture.accept("one", changed)).toBe(false);
      expect(yield* capture.stop()).toMatchObject({
        gaps: [gap],
        status: "incomplete",
      });
    }
  })
);

it.effect(
  "silence, exit, and slow-consumer events invalidate active capture",
  () =>
    Effect.gen(function* invalidateCapture() {
      for (const gap of [
        "stream-silence",
        "helper-exited",
        "slow-consumer",
      ] as const) {
        const capture = makeIosStreamIntegrity();
        yield* capture.generation("one");
        yield* capture.accept("one", packet(1));
        yield* capture.start(0);
        yield* capture.fail(gap);
        expect(yield* capture.stop()).toMatchObject({
          gaps: [gap],
          status: "incomplete",
        });
      }
    })
);

it("rejects malformed packets before retention", () => {
  const decode = Schema.decodeUnknownResult(IosFramebufferPacket);
  expect(decode({ ...packet(1), width: 0 })._tag).toBe("Failure");
  expect(decode({ ...packet(1), sequence: Number.NaN })._tag).toBe("Failure");
  expect(decode({ ...packet(1), jpeg: "" })._tag).toBe("Failure");
});

for (const [executable, verify] of [
  ["framebuffer", verifyIosFramebufferRelease],
  ["foreground", verifyIosForegroundRelease],
] as const) {
  it.effect(
    `hash-checks the ${executable} artifact and refuses tampering`,
    () =>
      Effect.gen(function* verifyRelease() {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() =>
            mkdtemp(path.join(tmpdir(), "contingency-ios-release-test-"))
          ),
          (owned) =>
            Effect.promise(() => rm(owned, { force: true, recursive: true }))
        );
        const bytes = Buffer.from("test helper bytes");
        const manifest = {
          architecture: "arm64",
          executable,
          platform: "darwin",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          signing: "ad-hoc",
          sourceSha256: "a".repeat(64),
          version: 1,
        };
        yield* Effect.promise(() =>
          writeFile(
            path.join(directory, "manifest.json"),
            JSON.stringify(manifest)
          )
        );
        yield* Effect.promise(() =>
          writeFile(path.join(directory, executable), bytes)
        );
        const host = { architecture: "arm64", platform: "darwin" };
        expect(yield* verify(directory, host)).toBe(
          path.join(directory, executable)
        );
        expect(
          (yield* Effect.result(
            verify(directory, { ...host, architecture: "x64" })
          ))._tag
        ).toBe("Failure");
        yield* Effect.promise(() =>
          writeFile(path.join(directory, executable), "tampered")
        );
        expect((yield* Effect.result(verify(directory, host)))._tag).toBe(
          "Failure"
        );
        yield* Effect.promise(() =>
          writeFile(
            path.join(directory, "manifest.json"),
            JSON.stringify({ ...manifest, executable: "../foreign" })
          )
        );
        expect((yield* Effect.result(verify(directory, host)))._tag).toBe(
          "Failure"
        );
      })
  );
}

it.effect(
  "excludes queued pre-Start samples and marks an empty interval incomplete",
  () =>
    Effect.gen(function* boundSamples() {
      const capture = makeIosStreamIntegrity();
      yield* capture.generation("one");
      yield* capture.accept("one", packet(1));
      expect(yield* capture.start(25)).toBe(true);
      expect(yield* capture.accept("one", packet(2))).toBe(true);
      expect(capture.snapshot()?.firstSequence).toBe(null);
      yield* capture.accept("one", packet(3));
      expect(yield* capture.stop()).toMatchObject({
        firstSequence: 3,
        lastSequence: 3,
        status: "stopped",
      });
      expect(yield* capture.start(100)).toBe(true);
      yield* capture.accept("one", packet(4));
      expect(yield* capture.stop()).toMatchObject({
        gaps: ["no-frames"],
        status: "incomplete",
      });
    })
);

it.effect("keeps the same recording interval across rotation", () =>
  Effect.gen(function* rotateCapture() {
    const capture = makeIosStreamIntegrity();
    yield* capture.generation("one");
    yield* capture.accept("one", packet(1));
    yield* capture.start(0);
    yield* capture.accept("one", packet(2));
    expect(
      yield* capture.accept("one", { ...packet(3), height: 720, width: 1500 })
    ).toBe(true);
    expect(yield* capture.stop()).toMatchObject({
      firstSequence: 2,
      gaps: [],
      lastSequence: 3,
      status: "stopped",
    });
  })
);

it.effect("keeps continuity across a positively rebound display port", () =>
  Effect.gen(function* replaceDisplay() {
    const capture = makeIosStreamIntegrity();
    yield* capture.generation("one");
    yield* capture.accept("one", packet(1));
    yield* capture.start(0);
    yield* capture.accept("one", packet(2));
    expect(
      yield* capture.accept("one", {
        ...packet(3),
        displayPort: "22222222-2222-2222-2222-222222222222",
        sourceSequence: 1,
      })
    ).toBe(true);
    expect(yield* capture.stop()).toMatchObject({
      firstSequence: 2,
      gaps: [],
      lastSequence: 3,
      status: "stopped",
    });
  })
);
