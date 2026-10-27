import path from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import type { Footprint, RegistryBaselines } from "./footprint.ts";
import {
  compareFootprints,
  FootprintSchema,
  measureFootprint,
  RegistryBaselinesSchema,
} from "./footprint.ts";

const output = Flag.String("output");
const readJson = <S extends Schema.Decoder<unknown>>(schema: S, file: string) =>
  Effect.gen(function* read() {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file);
    return yield* Effect.try(() =>
      Schema.decodeUnknownSync(schema)(JSON.parse(text))
    );
  });
const writeJson = (file: string, value: Footprint | RegistryBaselines) =>
  Effect.gen(function* write() {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(file, `${JSON.stringify(value, null, 2)}\n`);
  });
const threshold = (name: string, fallback: number) =>
  Flag.Finite(name).pipe(Flag.withDefault(fallback));
const fetchBaseline = (tag: string) =>
  measureFootprint(`@contingencyhq/cli@${tag}`, process.cwd()).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Console.warn(`npm ${tag} unavailable; reporting n/a`).pipe(
          Effect.as(null)
        ),
      onSuccess: Effect.succeed,
    })
  );
const root = Command.make("footprint", {}, () => Effect.void).pipe(
  Command.withSubcommands([
    Command.make(
      "measure",
      {
        output,
        root: Flag.String("root").pipe(Flag.withDefault(process.cwd())),
      },
      ({ output: file, root: directory }) =>
        Effect.gen(function* measure() {
          const snapshot = yield* measureFootprint(
            ".",
            path.resolve(directory, "packages/cli")
          );
          yield* writeJson(file, snapshot);
          yield* Console.log(
            `Measured CLI ${snapshot.version}: ${snapshot.packed} packed bytes, ${Object.keys(snapshot.files).length} installed files`
          );
        })
    ),
    Command.make("registry", { output }, ({ output: file }) =>
      Effect.gen(function* registry() {
        const latest = yield* fetchBaseline("latest");
        const alpha = yield* fetchBaseline("alpha");
        yield* writeJson(file, { alpha, latest });
      })
    ),
    Command.make(
      "compare",
      {
        base: Argument.String("base"),
        bytes: threshold("warn-bytes", 50 * 1024),
        head: Argument.String("head"),
        output,
        percent: threshold("warn-percent", 1),
        registry: Argument.String("registry"),
      },
      ({ base, head, registry, output: file, bytes, percent }) =>
        Effect.gen(function* compare() {
          if (
            !Number.isFinite(bytes) ||
            !Number.isFinite(percent) ||
            bytes < 0 ||
            percent < 0
          ) {
            return yield* Effect.fail(
              new Error("Warning thresholds must be finite nonnegative numbers")
            );
          }
          const result = compareFootprints(
            yield* readJson(FootprintSchema, base),
            yield* readJson(FootprintSchema, head),
            yield* readJson(RegistryBaselinesSchema, registry),
            { bytes, percent }
          );
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(file, result.markdown);
          yield* Console.log(result.markdown);
          for (const warning of result.warnings) {
            yield* Console.log(`::warning::CLI footprint: ${warning}`);
          }
        })
    ),
  ])
);
Command.run(root, { version: "0.0.1" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
