import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";

import { iosFramebufferVersion } from "../services/ios-framebuffer-release.ts";

const execute = promisify(execFile);
const output = path.resolve("dist/ios/framebuffer");
const source = path.resolve("ios/framebuffer/framebuffer.m");
const io = <A>(run: () => Promise<A>) => Effect.tryPromise(run);
const command = (file: string, args: readonly string[]) =>
  Effect.tryPromise({
    catch: () =>
      new Error("Could not build the Contingency iOS framebuffer helper."),
    try: (signal) => execute(file, args, { signal, timeout: 120_000 }),
  });

await Effect.runPromise(
  Effect.gen(function* packageIosFramebuffer() {
    // Other hosts still build the CLI, but carry no executable iOS backend.
    yield* io(() => rm(output, { force: true, recursive: true }));
    if (
      process.platform !== "darwin" ||
      process.env.CONTINGENCY_BUILD_IOS_FRAMEBUFFER !== "1"
    ) {
      return;
    }
    yield* io(() => mkdir(output, { recursive: true }));
    const executable = path.join(output, "framebuffer");
    yield* command("xcrun", [
      "clang",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wno-unused-parameter",
      "-fobjc-arc",
      "-arch",
      "arm64",
      "-framework",
      "Foundation",
      "-framework",
      "CoreImage",
      "-framework",
      "IOSurface",
      "-framework",
      "ImageIO",
      "-framework",
      "CoreGraphics",
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
            architecture: "arm64",
            executable: "framebuffer",
            platform: "darwin",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            signing: "ad-hoc",
            sourceSha256: createHash("sha256")
              .update(sourceBytes)
              .digest("hex"),
            version: iosFramebufferVersion,
          },
          null,
          2
        )}\n`
      )
    );
  })
);
