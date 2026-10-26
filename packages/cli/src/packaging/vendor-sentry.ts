import { createHash } from "node:crypto";
import path from "node:path";

import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";

// Reviewed 13.5.0: init returns before importing @sentry/node when
// enableErrorReporting is false. scan-engine explicitly supplies that flag.
const sentryHash =
  "ea85b7a359c5c47098d3f896652fca90e9a3b92ccf85aef75750d06bac540dd5";

export const lighthouseRuntimeDependencies = Effect.fn(
  "lighthouseRuntimeDependencies"
)(function* runtimeDependencies(
  name: string,
  version: string | undefined,
  dependencies: readonly string[],
  source: string
) {
  if (name !== "lighthouse") {
    return dependencies;
  }
  const fs = yield* FileSystem.FileSystem;
  const sentry = yield* fs.readFileString(
    path.join(source, "core/lib/sentry.js")
  );
  if (
    version !== "13.5.0" ||
    createHash("sha256").update(sentry).digest("hex") !== sentryHash ||
    dependencies
      .filter((dependency) => dependency.startsWith("@sentry/"))
      .join(",") !== "@sentry/node"
  ) {
    return yield* Effect.fail(
      new Error(
        "Lighthouse Sentry wiring changed; review error reporting before excluding its dependencies."
      )
    );
  }
  // A new import elsewhere must not silently bypass the reviewed delegate.
  const check = (
    relative: string
  ): Effect.Effect<void, Error | PlatformError> =>
    Effect.gen(function* checkDirectory() {
      for (const entry of yield* fs.readDirectory(
        path.join(source, relative)
      )) {
        if (entry === "node_modules") {
          continue;
        }
        const child = path.posix.join(relative, entry);
        const info = yield* fs.stat(path.join(source, child));
        if (info.type === "Directory") {
          yield* check(child);
        } else if (
          /\.(?:c|m)?js$/u.test(child) &&
          child !== "core/lib/sentry.js"
        ) {
          const code = yield* fs.readFileString(path.join(source, child));
          if (code.includes("@sentry/")) {
            return yield* Effect.fail(
              new Error(
                `Lighthouse Sentry wiring changed in ${child}; review dependency exclusion.`
              )
            );
          }
        }
      }
    });
  yield* check("");
  return dependencies.filter(
    (dependency) => !dependency.startsWith("@sentry/")
  );
});
