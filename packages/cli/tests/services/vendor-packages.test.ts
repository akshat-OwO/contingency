import { createRequire } from "node:module";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { vendorPackages } from "../../src/packaging/vendor-packages.ts";

interface FixtureManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
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
