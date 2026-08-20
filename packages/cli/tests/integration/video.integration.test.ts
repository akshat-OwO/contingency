import path from "node:path";

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
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
