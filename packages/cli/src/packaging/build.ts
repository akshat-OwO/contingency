import path from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const cliRoot = path.resolve(import.meta.dirname, "../..");

const run = (label: string, command: string, args: readonly string[]) =>
  Effect.gen(function* runBuildStep() {
    yield* Effect.logInfo(label);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        cwd: cliRoot,
        forceKillAfter: "5 seconds",
        stderr: "inherit",
        stdin: "ignore",
        stdout: "inherit",
      })
    );
    if (code !== 0) {
      return yield* Effect.fail(
        new Error(`${label} failed with exit code ${code}.`)
      );
    }
  });

Effect.gen(function* buildCli() {
  const fs = yield* FileSystem.FileSystem;

  yield* run("Generate settings", "vpx", [
    "src/packaging/generate-settings.ts",
  ]);
  yield* run("Bundle CLI", "vp", ["exec", "tsdown"]);
  yield* run("Vendor runtime dependencies", "vpx", [
    "src/packaging/vendor-runtime.ts",
  ]);
  yield* run("Build iOS framebuffer helper", "vpx", [
    "src/packaging/build-ios-framebuffer.ts",
  ]);

  yield* Effect.logInfo("Copy packaged resources");
  for (const directory of [
    "resources",
    "demo",
    "examples",
    "onboarding",
    "docs",
  ]) {
    yield* fs.copy(
      path.join(cliRoot, directory),
      path.join(cliRoot, "dist", directory),
      { overwrite: true }
    );
  }

  // Separate outputs let both sites build concurrently. A failure stops the
  // other process tree, and docs are copied only after both builds succeed.
  yield* Effect.all(
    [
      run("Build web app", "vp", [
        "run",
        "--filter",
        "@contingency/web",
        "build",
        "--outDir",
        "../../packages/cli/dist/web",
        "--emptyOutDir",
      ]),
      run("Build docs site", "vp", [
        "run",
        "--filter",
        "@contingency/docs",
        "build",
      ]),
    ],
    { concurrency: 2, discard: true }
  );

  yield* Effect.logInfo("Copy docs site");
  yield* fs.copy(
    path.resolve(cliRoot, "../../apps/docs/dist"),
    path.join(cliRoot, "dist/docs-site"),
    { overwrite: true }
  );
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
