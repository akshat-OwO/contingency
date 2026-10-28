import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";

import { iosForegroundVersion } from "../services/ios-foreground-release.ts";

const execute = promisify(execFile);
const output = path.resolve("dist/ios/foreground");
const source = path.resolve("ios/foreground/foreground.m");
const io = <A>(run: () => Promise<A>) => Effect.tryPromise(run);
const command = (file: string, args: readonly string[]) =>
  Effect.tryPromise({
    catch: () =>
      new Error("Could not build the Contingency iOS foreground helper."),
    try: (signal) => execute(file, args, { signal, timeout: 120_000 }),
  });

await Effect.runPromise(
  Effect.gen(function* packageIosForeground() {
    // Other hosts still build the CLI, but carry no executable iOS backend.
    yield* io(() => rm(output, { force: true, recursive: true }));
    if (
      process.platform !== "darwin" ||
      process.env.CONTINGENCY_BUILD_IOS_FRAMEBUFFER !== "1"
    ) {
      return;
    }
    if (process.arch !== "arm64" && process.arch !== "x64") {
      return yield* Effect.fail(
        new Error("Unsupported iOS helper host architecture.")
      );
    }
    yield* io(() => mkdir(output, { recursive: true }));
    const executable = path.join(output, "foreground");
    yield* command("xcrun", [
      "--sdk",
      "iphonesimulator",
      "clang",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wno-unused-parameter",
      "-fobjc-arc",
      "-target",
      process.arch === "x64"
        ? "x86_64-apple-ios26.0-simulator"
        : "arm64-apple-ios26.0-simulator",
      "-framework",
      "Foundation",
      source,
      "-o",
      executable,
    ]);
    yield* command("/usr/bin/codesign", ["--force", "--sign", "-", executable]);
    yield* command("/usr/bin/codesign", ["--verify", "--strict", executable]);
    const bytes = yield* io(() => readFile(executable));
    const sourceBytes = yield* io(() => readFile(source));
    yield* io(() =>
      writeFile(
        path.join(output, "manifest.json"),
        `${JSON.stringify(
          {
            architecture: process.arch,
            executable: "foreground",
            platform: "darwin",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            signing: "ad-hoc",
            sourceSha256: createHash("sha256")
              .update(sourceBytes)
              .digest("hex"),
            version: iosForegroundVersion,
          },
          null,
          2
        )}\n`
      )
    );
  })
);
