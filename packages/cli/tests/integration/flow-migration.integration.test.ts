import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { resolveUserAgent } from "@contingency/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { fixtureServer, IntegrationLive } from "./harness.ts";

const execute = promisify(execFile);

it.live("runs a migrated Flow without rewriting the opened source", () =>
  Effect.gen(function* runOlderFlow() {
    const fileSystem = yield* FileSystem.FileSystem;
    const fixtures = yield* fixtureServer;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "contingency-migration-",
    });
    const flowPath = path.join(directory, "older-flow.json");
    const outputDirectory = path.join(directory, "runs");
    const userAgent = resolveUserAgent("chrome-android-mobile", "141");
    const source = `${JSON.stringify(
      {
        emulation: { userAgent },
        steps: [{ type: "navigate", url: fixtures.url("checkout.html") }],
        title: "Older mobile Flow",
      },
      null,
      2
    )}\n`;
    yield* fileSystem.writeFileString(flowPath, source).pipe(Effect.orDie);

    yield* Effect.tryPromise({
      catch: (cause) => new Error(`The CLI failed: ${String(cause)}`),
      try: () =>
        execute(process.execPath, [
          path.join(import.meta.dirname, "..", "..", "src", "index.ts"),
          "run",
          flowPath,
          "--output",
          outputDirectory,
          "--retry",
          "0",
        ]),
    }).pipe(Effect.timeout("30 seconds"));

    expect(yield* fileSystem.readFileString(flowPath)).toBe(source);

    const [flowDirectory] = yield* fileSystem.readDirectory(outputDirectory);
    const [runDirectory] = yield* fileSystem.readDirectory(
      path.join(outputDirectory, flowDirectory ?? "")
    );
    const run = JSON.parse(
      yield* fileSystem.readFileString(
        path.join(
          outputDirectory,
          flowDirectory ?? "",
          runDirectory ?? "",
          "run.json"
        )
      )
    ) as {
      readonly flow?: {
        readonly emulation?: {
          readonly browser?: { readonly mobile?: boolean };
          readonly userAgent?: string;
        };
      };
    };
    expect(run.flow?.emulation?.browser?.mobile).toBe(true);
    expect(run.flow?.emulation?.userAgent).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(IntegrationLive))
);
