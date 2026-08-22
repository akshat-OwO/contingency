import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type { RunVideoManifest } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  canRecordVideo,
  fixtureServer,
  flow,
  IntegrationLive,
  runFlow,
} from "./harness";

const ffprobe = promisify(execFile);

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

it.live.skipIf(!canRecordVideo())("captures a Run to a playable WebM", () =>
  Effect.gen(function* captureRun() {
    const fileSystem = yield* FileSystem.FileSystem;
    const fixtures = yield* fixtureServer;

    const { directory, persisted } = yield* runFlow(
      flow(
        [
          { type: "navigate", url: fixtures.url("checkout.html") },
          { selectors: [["#name"]], type: "change", value: "Ada Lovelace" },
          {
            assertedEvents: [
              {
                title: "Order confirmed",
                type: "navigation",
                url: fixtures.url("confirmed.html"),
              },
            ],
            offsetX: 1,
            offsetY: 1,
            selectors: [["#submit"]],
            type: "click",
          },
        ],
        "Recorded checkout"
      ),
      { video: true }
    );

    expect(persisted.video).toBe(true);

    const manifest = JSON.parse(
      yield* fileSystem.readFileString(path.join(directory, "video.json"))
    ) as RunVideoManifest;
    expect(manifest.runId).toBe(persisted.runId);
    expect(manifest.containsSecrets).toBe(false);
    expect(manifest.segments).toHaveLength(1);

    const [segment] = manifest.segments;
    expect(segment?.recorded).toBe(true);
    expect(segment?.file).toBe("attempt-1.webm");

    // Playable, not merely present: a file the encoder never finished is a
    // zero-byte one, which is exactly what a lost recording looks like.
    const bytes = yield* fileSystem.readFile(
      path.join(directory, segment?.file ?? "")
    );
    expect(bytes.length).toBeGreaterThan(1024);
    expect(leadingHex(bytes, 4)).toBe(EBML);

    // Containing the load, not just the end state: size and magic both pass
    // on a hollow recording — a capture that navigated first recorded only
    // ~0.3s of typed-out final state and every guard above still held. The
    // recording must span the whole Run instead. The floor sits well above
    // what a hollow recording reaches and well below what even a contended
    // machine produces for this Run, so encoder timing cannot flake it.
    const recordingPath = path.join(directory, segment?.file ?? "");
    const probed = yield* Effect.tryPromise({
      catch: (cause) => new Error(`ffprobe failed: ${String(cause)}`),
      try: () =>
        ffprobe("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "csv=p=0",
          recordingPath,
        ]),
    });
    const durationSeconds = Number(String(probed.stdout).trim());
    expect(durationSeconds).toBeGreaterThan(0.5);
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);

it.live.skipIf(!canRecordVideo())(
  "still measures Core Web Vitals while capturing the Run to video",
  () =>
    Effect.gen(function* vitalsUnderCapture() {
      const fixtures = yield* fixtureServer;

      // Capture and measurement have to hold at once: a recording context is
      // a fresh browser context that inherits nothing from the session that
      // opened it, so a Run that filmed itself used to collect no vitals at
      // all — silently, because nothing about the Run failed.
      const { persisted } = yield* runFlow(
        flow([
          {
            contingency: { id: "open", performance: true },
            type: "navigate",
            url: fixtures.url("checkout.html"),
          },
          { selectors: [["#name"]], type: "change", value: "Ada Lovelace" },
        ]),
        { video: true }
      );

      expect(persisted.outcome).toBe("completed");
      const measured = persisted.steps.find(
        (step) => step.vitals !== undefined
      );
      // The opening navigation is the Run's own, performed after the capture
      // began, so it is measured like any other — including its LCP, which a
      // fresh context that never re-armed the recorder could not report.
      expect(measured?.vitals?.lcp).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
