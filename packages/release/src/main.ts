#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { applyReleaseVersion } from "./apply-version.ts";
import { resolveReleaseMetadata } from "./release-metadata.ts";

/**
 * Appends `key=value` lines to the file GitHub Actions reads step outputs
 * from. Absent the variable, the values go to stdout instead, which is what
 * makes these commands runnable by hand when a release needs debugging.
 */
const emit = Effect.fn("emit")(function* writeStepOutputs(
  entries: readonly (readonly [string, string])[]
) {
  const lines = entries.map(([key, value]) => `${key}=${value}`);
  const outputPath = process.env.GITHUB_OUTPUT;

  if (outputPath === undefined || outputPath === "") {
    yield* Console.log(lines.join("\n"));
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(outputPath, `${lines.join("\n")}\n`, {
    flag: "a",
  });
});

const resolveCommand = Command.make(
  "resolve",
  {
    version: Argument.string("version").pipe(
      Argument.withDescription(
        "The release version or tag, for example 1.2.3, v1.2.3, or v1.2.3-alpha.4."
      )
    ),
  },
  ({ version }) =>
    Effect.gen(function* resolveRelease() {
      const metadata = yield* Effect.fromResult(
        resolveReleaseMetadata(version)
      );

      yield* emit([
        ["version", metadata.version],
        ["tag", metadata.tag],
        ["dist_tag", metadata.distTag],
        ["is_prerelease", String(metadata.isPrerelease)],
        ["make_latest", String(metadata.makeLatest)],
        ["name", metadata.name],
      ]);
    })
).pipe(
  Command.withDescription(
    "Derive the npm dist-tag and GitHub Release flags from a release version."
  )
);

const applyCommand = Command.make(
  "apply-version",
  {
    root: Flag.string("root").pipe(
      Flag.withDescription("Repository root to stamp manifests in."),
      Flag.withDefault(process.cwd())
    ),
    version: Argument.string("version").pipe(
      Argument.withDescription("The version to write into every manifest.")
    ),
  },
  ({ root, version }) =>
    Effect.gen(function* stampRelease() {
      const metadata = yield* Effect.fromResult(
        resolveReleaseMetadata(version)
      );
      const updated = yield* applyReleaseVersion(metadata.version, root);

      yield* Console.log(
        updated.length === 0
          ? `Already at ${metadata.version}; nothing to stamp.`
          : `Stamped ${metadata.version} into:\n${updated.map((file) => `  ${file}`).join("\n")}`
      );
    })
).pipe(
  Command.withDescription(
    "Write the release version into every publishable package manifest."
  )
);

const root = Command.make("release", {}, () => Effect.void).pipe(
  Command.withSubcommands([resolveCommand, applyCommand])
);

Command.run(root, { version: "0.0.1" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain
);
