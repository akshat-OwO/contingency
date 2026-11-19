import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import {
  scrubPurgedInstructions,
  withoutPurgedInstructions,
} from "../../src/services/native-instruction-purge.ts";

const comment = { text: "Keep this only until Cleanup." };

const Summary = Schema.Struct({
  instructions: Schema.Array(Schema.Struct({ text: Schema.String })),
  recordingId: Schema.NullOr(Schema.String),
});

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Summary));

/** Every recording but `recording-kept` is purged. */
const purged = (recordingId: string) =>
  Effect.succeed(recordingId !== "recording-kept");

it("hides a purged recording's comments", () => {
  const summary = { instructions: [comment] };
  expect(withoutPurgedInstructions(summary, { _tag: "purged" })).toEqual({
    instructions: [],
  });
  expect(withoutPurgedInstructions(summary, { _tag: "pending" })).toBe(summary);
  expect(withoutPurgedInstructions(summary, null)).toBe(summary);
});

it.effect(
  "removes purged recordings' comments from persisted summaries only",
  () =>
    Effect.gen(function* scrub() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const write = (name: string, recordingId: string) =>
        fs.writeFileString(
          path.join(directory, name),
          JSON.stringify({ instructions: [comment], recordingId })
        );
      const read = (name: string) =>
        fs.readFileString(path.join(directory, name));
      yield* write("purged.json", "recording-purged");
      yield* write("kept.json", "recording-kept");
      yield* write("other.json", "recording-other");
      yield* fs.writeFileString(
        path.join(directory, "broken.json"),
        "{ not json"
      );

      yield* scrubPurgedInstructions({
        decode,
        directory,
        fs,
        purged,
        recordingId: "recording-purged",
      });
      expect(yield* read("purged.json")).not.toContain(comment.text);
      // Scoped to one recording, a purge leaves the others for later.
      expect(yield* read("other.json")).toContain(comment.text);

      yield* scrubPurgedInstructions({ decode, directory, fs, purged });
      expect(yield* read("other.json")).not.toContain(comment.text);
      expect(yield* read("kept.json")).toContain(comment.text);
      expect(yield* read("broken.json")).toBe("{ not json");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
