import type { Run } from "@contingency/protocol";
import { Effect, FileSystem } from "effect";
import { expect, test } from "vitest";

import {
  gateOverride,
  gateOverrideWarning,
  videoWarning,
} from "../../src/cmds/run-report.ts";

const videoRun = {
  video: true,
} as Run;

const fileSystemReading = (contents: string) =>
  FileSystem.layerNoop({
    readFileString: () => Effect.succeed(contents),
  });

/**
 * How `--gate` and `--ignore-gate` resolve to the Gate a Run is held to.
 *
 * These are the fiddliest semantics the command carries — an empty list means
 * something different from an absent one — and the integration suite drives
 * the Runner's options rather than argv, so it never reaches them. The matrix
 * is small enough to pin exhaustively, which is the only way the distinction
 * stays true as the flags grow.
 */

test("no flag leaves the Flow's own Gate alone", () => {
  // `undefined`, not `[]`: an absent flag must not silently clear a Gate the
  // Flow declared.
  expect(gateOverride([], false)).toBeUndefined();
});

test("--gate replaces the Flow's Gate with the rules given", () => {
  expect(gateOverride(["image-alt"], false)).toEqual(["image-alt"]);
  expect(gateOverride(["image-alt", "label"], false)).toEqual([
    "image-alt",
    "label",
  ]);
});

test("--ignore-gate holds the Run to nothing", () => {
  // An empty list is a deliberate override, distinct from an absent one: it
  // relaxes the bar to nothing whatever the Flow declares.
  expect(gateOverride([], true)).toEqual([]);
});

test("--ignore-gate beats --gate when both are given", () => {
  expect(gateOverride(["image-alt"], true)).toEqual([]);
});

test("a conflicting pair of Gate flags is warned about, not resolved silently", () => {
  expect(gateOverrideWarning(["image-alt"], true)).toContain("--ignore-gate");
});

test("an unambiguous invocation warns nothing", () => {
  expect(gateOverrideWarning([], false)).toBeUndefined();
  expect(gateOverrideWarning(["image-alt"], false)).toBeUndefined();
  expect(gateOverrideWarning([], true)).toBeUndefined();
});

test("a malformed video manifest produces a warning instead of a defect", async () => {
  const warning = await Effect.runPromise(
    videoWarning(videoRun, "/runs/example").pipe(
      Effect.provide(fileSystemReading("{ truncated"))
    )
  );

  expect(warning).toContain("manifest could not be read");
});

test("a video manifest is schema-validated before it is reported", async () => {
  const warning = await Effect.runPromise(
    videoWarning(videoRun, "/runs/example").pipe(
      Effect.provide(
        fileSystemReading(
          JSON.stringify({ containsSecrets: false, runId: "run", segments: 1 })
        )
      )
    )
  );

  expect(warning).toContain("manifest could not be read");
});
