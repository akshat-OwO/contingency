import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";

import {
  iosFramebufferVersion,
  iosHidVersion,
} from "../services/ios-framebuffer-release.ts";

const execute = promisify(execFile);
/** The display helper and the Forwarded Input helper, built the same way. */
const helpers = [
  {
    frameworks: [
      "Foundation",
      "CoreImage",
      "IOSurface",
      "ImageIO",
      "CoreGraphics",
    ],
    name: "framebuffer",
    version: iosFramebufferVersion,
  },
  {
    frameworks: ["Foundation", "AppKit", "CoreGraphics"],
    name: "hid",
    version: iosHidVersion,
  },
] as const;
const outputOf = (name: string) => path.resolve("dist/ios", name);
const io = <A>(run: () => Promise<A>) => Effect.tryPromise(run);
const command = (file: string, args: readonly string[]) =>
  Effect.tryPromise({
    catch: () => new Error("Could not build the Contingency iOS helpers."),
    try: (signal) => execute(file, args, { signal, timeout: 120_000 }),
  });

/**
 * Whether this build carries the helper. An Apple Silicon Mac builds it by
 * default, so a local build can open iOS sessions; `0` opts out and `1`
 * insists, failing the build when the helper cannot be made (CI and release).
 */
const choice = process.env.CONTINGENCY_BUILD_IOS_FRAMEBUFFER;
const required = choice === "1";
const wanted =
  required ||
  (choice !== "0" && process.platform === "darwin" && process.arch === "arm64");

const buildHelper = (helper: (typeof helpers)[number]) =>
  Effect.gen(function* buildIosHelper() {
    const output = outputOf(helper.name);
    const source = path.resolve(`ios/${helper.name}/${helper.name}.m`);
    yield* io(() => mkdir(output, { recursive: true }));
    const executable = path.join(output, helper.name);
    yield* command("xcrun", [
      "clang",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wno-unused-parameter",
      "-fobjc-arc",
      "-arch",
      "arm64",
      ...helper.frameworks.flatMap((framework) => ["-framework", framework]),
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
            executable: helper.name,
            platform: "darwin",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            signing: "ad-hoc",
            sourceSha256: createHash("sha256")
              .update(sourceBytes)
              .digest("hex"),
            version: helper.version,
          },
          null,
          2
        )}\n`
      )
    );
  });
const build = Effect.forEach(helpers, buildHelper, { discard: true });
const removeOutputs = Effect.forEach(
  helpers,
  (helper) =>
    io(() => rm(outputOf(helper.name), { force: true, recursive: true })),
  { discard: true }
);

await Effect.runPromise(
  Effect.gen(function* packageIosFramebuffer() {
    // Other hosts still build the CLI, but carry no executable iOS backend.
    yield* removeOutputs;
    if (!wanted || process.platform !== "darwin") {
      return;
    }
    if (required) {
      return yield* build;
    }
    // A default build without Xcode's toolchain still succeeds, without iOS.
    yield* build.pipe(
      Effect.catch(() =>
        Effect.andThen(
          removeOutputs,
          Effect.sync(() =>
            console.warn(
              "Skipped the iOS helpers: Xcode's clang is unavailable. iOS sessions need it; set CONTINGENCY_BUILD_IOS_FRAMEBUFFER=1 to make this an error."
            )
          )
        )
      )
    );
  })
);
