import { createRequire } from "node:module";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  hasTypeScriptRuntime,
  shouldVendorFile,
  vendorPackages,
} from "../../src/packaging/vendor-packages.ts";
import { lighthouseRuntimeDependencies } from "../../src/packaging/vendor-sentry.ts";

interface FixtureManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports?: unknown;
  readonly main?: string;
  readonly name: string;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<
    Record<string, { readonly optional: boolean }>
  >;
  readonly version?: string;
}

const fixture = Effect.gen(function* makeFixture() {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: "vendor-packages-",
  });
  const source = path.join(directory, "source");
  const output = path.join(directory, "dist");
  yield* fs.makeDirectory(path.join(source, "node_modules"), {
    recursive: true,
  });
  const writePackage = Effect.fn("writeFixturePackage")(function* write(
    relative: string,
    manifest: FixtureManifest,
    code = "module.exports = 'unused';"
  ) {
    const target = path.join(source, relative);
    yield* fs.makeDirectory(target, { recursive: true });
    yield* fs.writeFileString(
      path.join(target, "package.json"),
      JSON.stringify({ main: "index.cjs", ...manifest })
    );
    yield* fs.writeFileString(path.join(target, "index.cjs"), code);
    yield* fs.writeFileString(
      path.join(target, "asset.txt"),
      "asset preserved"
    );
    return target;
  });
  return { fs, output, source, writePackage };
});

it.effect(
  "vendors store symlinks, assets, cycles, peers and conflicting versions into a movable directory",
  () =>
    Effect.gen(function* relocate() {
      const { fs, output, source, writePackage } = yield* fixture;
      const a = yield* writePackage(
        "store/a",
        { dependencies: { cycle: "1", shared: "1" }, name: "a", version: "1" },
        "module.exports = [require('shared'), require('node:fs').readFileSync(require('node:path').join(__dirname, 'asset.txt'), 'utf8')];"
      );
      const b = yield* writePackage(
        "store/b",
        { name: "b", peerDependencies: { shared: "2" }, version: "1" },
        "module.exports = require('shared');"
      );
      yield* fs.symlink(a, path.join(source, "node_modules/a"));
      yield* fs.symlink(b, path.join(source, "node_modules/b"));
      yield* writePackage(
        "store/a/node_modules/shared",
        { name: "shared", version: "1" },
        "module.exports = 'one';"
      );
      yield* writePackage(
        "store/b/node_modules/shared",
        { name: "shared", version: "2" },
        "module.exports = 'two';"
      );
      yield* writePackage(
        "node_modules/shared",
        { name: "shared", version: "2" },
        "module.exports = 'root two';"
      );
      yield* writePackage("node_modules/cycle", {
        dependencies: { a: "1" },
        name: "cycle",
        optionalDependencies: { absent: "1" },
        peerDependencies: { optionalPeer: "1" },
        peerDependenciesMeta: { optionalPeer: { optional: true } },
        version: "1",
      });
      yield* vendorPackages(["a", "b", "shared"], source, output);
      yield* fs.remove(source, { recursive: true });
      const require = createRequire(path.join(output, "entry.cjs"));
      expect(require("a")).toEqual(["one", "asset preserved"]);
      expect(require("b")).toBe("two");
      expect(require("shared")).toBe("root two");
      expect(
        yield* fs.exists(path.join(output, "node_modules/cycle/package.json"))
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "rejects a missing required dependency before releasing a broken bundle",
  () =>
    Effect.gen(function* missingDependency() {
      const { source, output, writePackage } = yield* fixture;
      yield* writePackage("node_modules/broken", {
        dependencies: { "missing-vendor-fixture": "1" },
        name: "broken",
      });
      const error = yield* vendorPackages(["broken"], source, output).pipe(
        Effect.flip
      );
      expect(error.message).toContain("Cannot vendor missing-vendor-fixture");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it("filters dependency build metadata while retaining runtime files", () => {
  for (const file of [
    "index.js.map",
    "nested/index.d.ts",
    "index.d.mts",
    "index.d.cts",
    "src/index.ts",
    "src/index.mts",
    "src/index.cts",
    "node_modules/child/index.js",
  ]) {
    expect(shouldVendorFile(file)).toBe(false);
  }
  for (const file of [
    "package.json",
    "index.js",
    "index.mjs",
    "index.cjs",
    "data.json",
    "assets/font.woff2",
    "LICENSE",
    "bin/runner",
    "tsconfig.json",
  ]) {
    expect(shouldVendorFile(file)).toBe(true);
  }
  expect(shouldVendorFile("src/index.ts", true)).toBe(true);
  expect(shouldVendorFile("src/index.ts.map", true)).toBe(false);
  expect(
    hasTypeScriptRuntime({ import: "./index.js", types: "./index.d.ts" })
  ).toBe(false);
  expect(
    hasTypeScriptRuntime({
      ".": { "@zod/source": "./src/index.ts", default: "./index.js" },
    })
  ).toBe(true);
  expect(hasTypeScriptRuntime([null, { runner: "./bin/run.mts" }])).toBe(true);
});

it.effect(
  "filters nested files, skips unresolved type packages and preserves TypeScript runtime entries",
  () =>
    Effect.gen(function* filterPackages() {
      const { fs, source, output, writePackage } = yield* fixture;
      const runtime = yield* writePackage("node_modules/runtime", {
        dependencies: { "@types/missing": "1", typed: "1" },
        name: "runtime",
      });
      const typed = yield* writePackage("node_modules/typed", {
        exports: { default: "./entry.cts", types: "./index.d.ts" },
        name: "typed",
      });
      yield* fs.makeDirectory(path.join(runtime, "nested"));
      for (const file of [
        "nested/source.ts",
        "nested/types.d.ts",
        "nested/index.js.map",
      ]) {
        yield* fs.writeFileString(path.join(runtime, file), "unused");
      }
      yield* fs.writeFileString(path.join(runtime, "nested/asset.json"), "{}");
      yield* fs.writeFileString(
        path.join(typed, "entry.cts"),
        "module.exports = require('./value.cts');"
      );
      yield* fs.writeFileString(
        path.join(typed, "value.cts"),
        "module.exports = 'typed runtime';"
      );
      yield* vendorPackages(["runtime", "@types/missing"], source, output);
      yield* fs.remove(source, { recursive: true });
      for (const file of [
        "nested/source.ts",
        "nested/types.d.ts",
        "nested/index.js.map",
      ]) {
        expect(
          yield* fs.exists(path.join(output, "node_modules/runtime", file))
        ).toBe(false);
      }
      expect(
        yield* fs.exists(
          path.join(output, "node_modules/runtime/nested/asset.json")
        )
      ).toBe(true);
      expect(yield* fs.exists(path.join(output, "node_modules/@types"))).toBe(
        false
      );
      expect(
        yield* fs.readFileString(
          path.join(output, "node_modules/typed/entry.cts")
        )
      ).toContain("require('./value.cts')");
      expect(
        yield* fs.readFileString(
          path.join(output, "node_modules/typed/value.cts")
        )
      ).toContain("typed runtime");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "ships only English locale assets and rewrites Lighthouse's registry",
  () =>
    Effect.gen(function* englishLocales() {
      const { fs, source, output, writePackage } = yield* fixture;
      const lighthouse = yield* writePackage("node_modules/lighthouse", {
        dependencies: { "@sentry/node": "1" },
        name: "lighthouse",
        version: "13.5.0",
      });
      const trace = yield* writePackage(
        "node_modules/@paulirish/trace_engine",
        {
          name: "@paulirish/trace_engine",
          version: "0.0.65",
        }
      );
      yield* fs.makeDirectory(path.join(lighthouse, "core/lib"), {
        recursive: true,
      });
      yield* fs.copyFile(
        path.resolve("node_modules/lighthouse/core/lib/sentry.js"),
        path.join(lighthouse, "core/lib/sentry.js")
      );
      const localization = path.join(lighthouse, "shared/localization");
      yield* fs.makeDirectory(localization, { recursive: true });
      // Exercise the reviewed upstream registry, including all static imports.
      yield* fs.copyFile(
        path.resolve("node_modules/lighthouse/shared/localization/locales.js"),
        path.join(localization, "locales.js")
      );
      for (const directory of [localization, trace]) {
        yield* fs.makeDirectory(path.join(directory, "locales"));
        for (const locale of ["en-US", "en-XL", "fr"]) {
          yield* fs.writeFileString(
            path.join(directory, "locales", `${locale}.json`),
            "{}"
          );
        }
      }
      yield* vendorPackages(
        ["lighthouse", "@paulirish/trace_engine"],
        source,
        output
      );
      yield* fs.remove(source, { recursive: true });
      for (const relative of [
        "lighthouse/shared/localization",
        "@paulirish/trace_engine",
      ]) {
        expect(
          yield* fs.readDirectory(
            path.join(output, "node_modules", relative, "locales")
          )
        ).toEqual(["en-US.json"]);
      }
      const registry = yield* fs.readFileString(
        path.join(
          output,
          "node_modules/lighthouse/shared/localization/locales.js"
        )
      );
      expect(registry).toContain("const locales = {'en-US': enUS, en: enUS}");
      expect(registry).toContain("export {locales}");
      expect(registry).not.toContain("import ar from");
      expect(registry).not.toContain("import enXL from");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("fails loudly when Lighthouse changes its locale registry", () =>
  Effect.gen(function* changedRegistry() {
    const { fs, source, output, writePackage } = yield* fixture;
    const lighthouse = yield* writePackage("node_modules/lighthouse", {
      name: "lighthouse",
    });
    const localization = path.join(lighthouse, "shared/localization");
    yield* fs.makeDirectory(localization, { recursive: true });
    yield* fs.writeFileString(
      path.join(localization, "locales.js"),
      "export const locales = {};\n"
    );
    const error = yield* vendorPackages(["lighthouse"], source, output).pipe(
      Effect.flip
    );
    expect(error.message).toContain("Lighthouse locales.js changed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "requires a locale loading review when trace_engine changes version",
  () =>
    Effect.gen(function* changedTraceEngine() {
      const { source, output, writePackage } = yield* fixture;
      yield* writePackage("node_modules/@paulirish/trace_engine", {
        name: "@paulirish/trace_engine",
        version: "0.0.66",
      });
      const error = yield* vendorPackages(
        ["@paulirish/trace_engine"],
        source,
        output
      ).pipe(Effect.flip);
      expect(error.message).toContain("review its locale loading");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

const sentryFixture = Effect.gen(function* makeSentryFixture() {
  const setup = yield* fixture;
  const { fs, writePackage } = setup;
  const lighthouse = yield* writePackage("node_modules/lighthouse", {
    dependencies: { "@sentry/node": "1", retained: "1" },
    name: "lighthouse",
    version: "13.5.0",
  });
  for (const file of [
    "core/lib/sentry.js",
    "shared/localization/locales.js",
    "shared/localization/locales/en-US.json",
  ]) {
    yield* fs.makeDirectory(path.dirname(path.join(lighthouse, file)), {
      recursive: true,
    });
    yield* fs.copyFile(
      path.resolve("node_modules/lighthouse", file),
      path.join(lighthouse, file)
    );
  }
  yield* writePackage("node_modules/@sentry/node", {
    dependencies: { "@opentelemetry/exclusive": "1", shared: "1" },
    name: "@sentry/node",
  });
  yield* writePackage("node_modules/@opentelemetry/exclusive", {
    dependencies: { "import-in-the-middle": "1" },
    name: "@opentelemetry/exclusive",
  });
  yield* writePackage("node_modules/import-in-the-middle", {
    dependencies: { "@sentry/node": "1" },
    name: "import-in-the-middle",
  });
  yield* writePackage("node_modules/shared", { name: "shared" });
  yield* writePackage(
    "node_modules/retained",
    {
      name: "retained",
      optionalDependencies: { shared: "1" },
    },
    "module.exports = require('shared');"
  );
  return { ...setup, lighthouse };
});

it.effect(
  "omits Lighthouse's exclusive Sentry closure while preserving shared optional and peer dependencies",
  () =>
    Effect.gen(function* exclusiveClosure() {
      const { fs, source, output } = yield* sentryFixture;
      yield* vendorPackages(["lighthouse"], source, output);
      for (const name of [
        "@sentry/node",
        "@opentelemetry/exclusive",
        "import-in-the-middle",
      ]) {
        expect(yield* fs.exists(path.join(output, "node_modules", name))).toBe(
          false
        );
      }
      yield* fs.remove(source, { recursive: true });
      const require = createRequire(path.join(output, "entry.cjs"));
      expect(require("retained")).toBe("unused");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "retains Sentry and its closure when another root needs it through a peer",
  () =>
    Effect.gen(function* retainedSentry() {
      const { fs, source, output, writePackage } = yield* sentryFixture;
      yield* writePackage("node_modules/other", {
        name: "other",
        peerDependencies: { "@sentry/node": "1" },
      });
      yield* vendorPackages(["lighthouse", "other"], source, output);
      for (const name of [
        "@sentry/node",
        "@opentelemetry/exclusive",
        "import-in-the-middle",
        "shared",
      ]) {
        expect(
          yield* fs.exists(
            path.join(output, "node_modules", name, "package.json")
          )
        ).toBe(true);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "requires a Sentry review for changed versions, delegate code, dependencies or new import sites",
  () =>
    Effect.gen(function* changedSentry() {
      const { fs, lighthouse } = yield* sentryFixture;
      const dependencies = ["@sentry/node", "retained"];
      for (const [version, names] of [
        ["13.5.1", dependencies],
        ["13.5.0", ["@sentry/new"]],
      ] as const) {
        const error = yield* lighthouseRuntimeDependencies(
          "lighthouse",
          version,
          names,
          lighthouse
        ).pipe(Effect.flip);
        expect(error.message).toContain("Lighthouse Sentry wiring changed");
      }
      yield* fs.writeFileString(
        path.join(lighthouse, "new.js"),
        "import '@sentry/node';"
      );
      const importError = yield* lighthouseRuntimeDependencies(
        "lighthouse",
        "13.5.0",
        dependencies,
        lighthouse
      ).pipe(Effect.flip);
      expect(importError.message).toContain("changed in new.js");
      yield* fs.remove(path.join(lighthouse, "new.js"));
      yield* fs.writeFileString(
        path.join(lighthouse, "core/lib/sentry.js"),
        "export const Sentry = {};"
      );
      const delegateError = yield* lighthouseRuntimeDependencies(
        "lighthouse",
        "13.5.0",
        dependencies,
        lighthouse
      ).pipe(Effect.flip);
      expect(delegateError.message).toContain(
        "Lighthouse Sentry wiring changed"
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
