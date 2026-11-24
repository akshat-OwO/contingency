import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Scope } from "effect";

import { childOutputsOf } from "../../src/services/child-process.ts";
import {
  FailureReferences,
  lookupFailure,
  makeFailureReferenceStore,
} from "../../src/services/failure-reference.ts";
import { makeTeachingEncoder } from "../../src/services/teaching-encoder.ts";

const frame = readFileSync(
  path.join(import.meta.dirname, "../fixtures/teaching-frame.jpg")
);
// ffmpeg names its output in the error it prints, so the path stands in
// for anything a child might echo.
const output = "/nonexistent-contingency-directory/private-name/teaching.webm";

it.effect(
  "an encoder that fails names a Failure Reference, and its stderr stays behind it",
  () =>
    Effect.gen(function* failedEncoder() {
      const scope = yield* Scope.make();
      const encoder = yield* makeTeachingEncoder({
        maxBytes: 1024 * 1024,
        output,
      }).pipe(Scope.provide(scope));
      yield* encoder.write(new Uint8Array(frame));
      // Closing ends the input and waits for ffmpeg to exit on its own.
      yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("30 seconds"));
      const failure = yield* encoder.failure;
      expect(failure).toMatch(
        /^The Teaching video encoder exited unexpectedly\. Failure Reference [0-9A-HJKMNP-TV-Z]{6}\.$/u
      );
      const reference = failure?.slice(-7, -1) ?? "";
      const cause = yield* lookupFailure(reference);
      const [ffmpeg] = Option.match(cause, {
        onNone: () => [],
        onSome: childOutputsOf,
      });
      expect(ffmpeg?.child).toBe("ffmpeg");
      expect(ffmpeg?.output.stderr).toContain("private-name");
    }).pipe(
      Effect.provideService(FailureReferences, makeFailureReferenceStore())
    )
);
