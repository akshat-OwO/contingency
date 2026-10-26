import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

import { Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

// Review covers every JS consumer and manifest, including dynamic loaders,
// createRequire, filesystem reads and all export conditions. Hash paths too:
// an added consumer must force a review even without a version bump.
interface DataPolicy {
  readonly hash: string;
  readonly paths: readonly string[];
}

const reviewed = new Map<string, DataPolicy>(
  Object.entries({
    "@paulirish/trace_engine": {
      hash: "abbdbd0a5fd7cd42a2b844094514c337ce0136f4d92a351e8fd46a7bf6a1a6a8",
      // Only test-trace-engine.mjs opens the gzipped fixture. Neither the main
      // trace entry nor Lighthouse imports this test runner.
      paths: ["test"],
    },
    enquirer: {
      hash: "c7e987d3df1005ddcf7441b99e5c91e7af69c5aaf08e998eaf40437fcd5729ae",
      paths: ["README.md"],
    },
    lighthouse: {
      hash: "24cfdad86af147af75ed85ef235c41f0e2111369d21131aaf88f599db4d820d8",
      paths: ["changelog-pre10.md"],
    },
    "playwright-core": {
      hash: "270381ffbce14cc0489bb70b3227d3809d864cb132585e7206a59b84c5fb6455",
      // No package consumer or export loads the test runner's HTML reporter.
      // Keep recorder (PWDEBUG), traceViewer and dashboard: coreBundle still
      // references their assets. Tracing and injected engine scripts stay too.
      paths: ["lib/vite/htmlReport"],
    },
    "puppeteer-core": {
      hash: "c2bb50c36786292b3a36f7fe59638077127cb9e2bd49256297e32f3305b8d489",
      // Node import/require and Lighthouse load lib/puppeteer. Only Wireit's
      // build:es5 task mentions this standalone browser script. Wildcard
      // exports permit explicit subpath access, which no CLI consumer uses.
      paths: ["lib/es5-iife"],
    },
    "third-party-web": {
      hash: "79da3fbbb84c0ef1bf1193af1b5ef74d539db5c256e64a2ee159e98838b70486",
      // lib/index.js and the subset aliases load entities*.json, never the CSV.
      // No consumer reads Yarn's installation metadata or the generated README.
      paths: ["dist/domain-map.csv", ".yarn", "README.md"],
    },
    "type-fest": {
      hash: "c6cadd285d7da3f7d334ac51f41ca730325bfb35e7b1f630a6cd5bb6f98b4d18",
      paths: ["readme.md"],
    },
  })
);

const consumerFile = /\.(?:c|m)?js$/u;

export const reviewVendorData = Effect.fn("reviewVendorData")(function* review(
  name: string,
  source: string,
  dependencies: readonly string[]
) {
  const excluded: string[] = [];
  const policy = reviewed.get(name);
  if (policy === undefined) {
    return {
      cutBaseline: false,
      cutBrowserBuild: false,
      dependencies,
      excluded,
    };
  }
  const fs = yield* FileSystem.FileSystem;
  for (const relative of policy.paths) {
    if (yield* fs.exists(path.join(source, relative))) {
      excluded.push(relative);
    }
  }
  const cutBrowserBuild = name === "puppeteer-core" && excluded.length > 0;
  const cutBaseline =
    name === "lighthouse" && dependencies.includes("web-features");
  if (excluded.length === 0 && !cutBaseline) {
    return { cutBaseline, cutBrowserBuild, dependencies, excluded };
  }
  const files: string[] = [];
  const collect = (relative: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* collectConsumers() {
      for (const entry of yield* fs.readDirectory(
        path.join(source, relative)
      )) {
        if (entry === "node_modules") {
          continue;
        }
        const child = path.posix.join(relative, entry);
        const info = yield* fs.stat(path.join(source, child));
        if (info.type === "Directory") {
          yield* collect(child);
        } else if (consumerFile.test(child) || entry === "package.json") {
          files.push(child);
        }
      }
    });
  yield* collect("");
  const hash = createHash("sha256");
  for (const file of files.toSorted()) {
    hash
      .update(file)
      .update("\0")
      .update(yield* fs.readFile(path.join(source, file)))
      .update("\0");
  }
  if (hash.digest("hex") !== policy.hash) {
    return yield* Effect.fail(
      new Error(
        `${name} consumers changed; review unused vendor data before updating its hash.`
      )
    );
  }
  // Lighthouse's baseline audit loads core/lib/baseline/web-features-*.json.
  // web-features is a build input with no runtime import or filesystem reader.
  // Cut only this edge; another package may still need web-features.
  return {
    cutBaseline,
    cutBrowserBuild,
    dependencies: cutBaseline
      ? dependencies.filter((dependency) => dependency !== "web-features")
      : dependencies,
    excluded,
  };
});

const preserveBaselineLicense = Effect.fn("preserveBaselineLicense")(
  function* license(source: string, target: string) {
    const fs = yield* FileSystem.FileSystem;
    const entry = yield* Effect.try({
      catch: (cause) =>
        new Error("Cannot resolve web-features license", { cause }),
      try: () =>
        createRequire(path.join(source, "package.json")).resolve(
          "web-features"
        ),
    });
    yield* fs.copyFile(
      path.join(path.dirname(entry), "LICENSE.txt"),
      path.join(target, "third-party/web-features.LICENSE.txt")
    );
  }
);

export const writeVendorDataManifest = Effect.fn("writeVendorDataManifest")(
  function* writeManifest(
    review: {
      readonly cutBaseline: boolean;
      readonly cutBrowserBuild: boolean;
    },
    source: string,
    target: string,
    text: string
  ) {
    if (!review.cutBaseline && !review.cutBrowserBuild) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    // Preserve all unmodeled manifest fields while removing the reviewed edge.
    const original = yield* Effect.try({
      catch: (cause) =>
        new Error(`Invalid vendor manifest at ${source}`, { cause }),
      try: () => {
        const value = Schema.decodeUnknownSync(
          Schema.Record(Schema.String, Schema.Unknown)
        )(JSON.parse(text));
        if (review.cutBrowserBuild) {
          // Installation/build tooling is never executed from dist. Removing
          // Wireit also removes its sole references to the omitted IIFE build.
          const { wireit: _wireit, ...runtime } = value;
          return runtime;
        }
        const dependencies = Schema.decodeUnknownSync(
          Schema.Record(Schema.String, Schema.String)
        )(value.dependencies);
        return {
          ...value,
          dependencies: Object.fromEntries(
            Object.entries(dependencies).filter(
              ([dependency]) => dependency !== "web-features"
            )
          ),
        };
      },
    });
    yield* fs.writeFileString(
      path.join(target, "package.json"),
      `${JSON.stringify(original, null, 2)}\n`
    );
    if (review.cutBaseline) {
      yield* preserveBaselineLicense(source, target);
    }
  }
);
