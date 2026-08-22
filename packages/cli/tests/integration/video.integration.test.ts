import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { RunVideoManifest } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { fixtureServer, flow, IntegrationLive, runFlow } from "./harness";

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

/**
 * Decoding a WebM to assert what it contains needs `ffprobe`, which is not
 * present everywhere. Tests that decode are skipped there rather than failed:
 * the absence is the environment's, not the code's.
 */
const canDecodeVideo = (): boolean =>
  (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .some((directory) => existsSync(path.join(directory, "ffprobe")));

it.live.skipIf(!canDecodeVideo())("captures a Run to a playable WebM", () =>
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
    // on a hollow recording. The recording must span the whole Run instead.
    // The floor sits well below what even a contended machine produces for
    // this Run, so encoder timing cannot flake it.
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
