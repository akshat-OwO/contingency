import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";

import {
  reviewVendorData,
  writeVendorDataManifest,
} from "../../src/packaging/vendor-data.ts";
import { vendorPackages } from "../../src/packaging/vendor-packages.ts";

const require = createRequire(
  realpathSync(path.resolve("node_modules/lighthouse/package.json"))
);
const thirdParty = path.dirname(
  path.dirname(require.resolve("third-party-web"))
);

it.effect(
  "copies reviewed packages without unused data and preserves runtime datasets and licenses",
  () =>
    Effect.gen(function* trimmedPackages() {
      const fs = yield* FileSystem.FileSystem;
      const output = yield* fs.makeTempDirectoryScoped({
        prefix: "vendor-data-",
      });
      const source = yield* fs.makeTempDirectoryScoped({
        prefix: "vendor-data-source-",
      });
      yield* fs.makeDirectory(path.join(source, "node_modules"));
      yield* fs.symlink(
        thirdParty,
        path.join(source, "node_modules/third-party-web")
      );
      yield* vendorPackages(["third-party-web"], source, output);
      const lighthouse = realpathSync(path.resolve("node_modules/lighthouse"));
      const data = yield* reviewVendorData("lighthouse", lighthouse, [
        "web-features",
        "third-party-web",
      ]);
      expect(data.dependencies).toEqual(["third-party-web"]);
      expect(data.excluded).toEqual(["changelog-pre10.md"]);
      const target = path.join(output, "node_modules/lighthouse");
      yield* fs.makeDirectory(path.join(target, "third-party"), {
        recursive: true,
      });
      yield* writeVendorDataManifest(
        data,
        lighthouse,
        target,
        yield* fs.readFileString(path.join(lighthouse, "package.json"))
      );
      for (const relative of [
        "core/lib/baseline/web-features-data.json",
        "core/lib/baseline/web-features-metadata.json",
      ]) {
        expect(yield* fs.exists(path.join(lighthouse, relative))).toBe(true);
      }
      for (const { name, asset } of [
        { asset: "test", name: "@paulirish/trace_engine" },
        { asset: "README.md", name: "enquirer" },
        { asset: "readme.md", name: "type-fest" },
      ]) {
        const candidates = require.resolve.paths(name) ?? [];
        // These are transitive dependencies; resolve through their direct owner.
        const owner =
          name === "type-fest"
            ? createRequire(require.resolve("configstore"))
            : require;
        const paths =
          name === "type-fest" ? (owner.resolve.paths(name) ?? []) : candidates;
        let found = false;
        for (const directory of paths) {
          const packageRoot = path.join(directory, name);
          if (yield* fs.exists(path.join(packageRoot, "package.json"))) {
            expect(
              (yield* reviewVendorData(name, packageRoot, [])).excluded
            ).toContain(asset);
            found = true;
            break;
          }
        }
        expect(found, `${name} installed package`).toBe(true);
      }
      for (const relative of [
        "third-party-web/dist/domain-map.csv",
        "third-party-web/.yarn",
        "third-party-web/README.md",
        "@paulirish/trace_engine/test",
        "lighthouse/changelog-pre10.md",
        "enquirer/README.md",
        "type-fest/readme.md",
        "web-features",
      ]) {
        expect(
          yield* fs.exists(path.join(output, "node_modules", relative))
        ).toBe(false);
      }
      for (const relative of [
        "third-party-web/dist/entities.json",
        "third-party-web/dist/entities-nostats.json",
        "third-party-web/LICENSE",
        "lighthouse/third-party/web-features.LICENSE.txt",
      ]) {
        expect(
          yield* fs.exists(path.join(output, "node_modules", relative))
        ).toBe(true);
      }
      const manifest = yield* fs.readFileString(
        path.join(output, "node_modules/lighthouse/package.json")
      );
      expect(manifest).not.toContain('"web-features"');
      const relocated = createRequire(path.join(output, "entry.cjs"));
      expect(
        relocated("third-party-web").getEntity(
          "https://www.google-analytics.com/analytics.js"
        ).name
      ).toBe("Google Analytics");
      expect(
        relocated("third-party-web/nostats-subset.js").entities.length
      ).toBeGreaterThan(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect("retains web-features when another root needs it", () =>
  Effect.gen(function* sharedDependency() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "vendor-data-edge-",
    });
    const source = path.join(directory, "source");
    const output = path.join(directory, "dist");
    yield* fs.makeDirectory(path.join(source, "node_modules/other"), {
      recursive: true,
    });
    yield* fs.symlink(
      path.resolve("node_modules/lighthouse"),
      path.join(source, "node_modules/lighthouse")
    );
    yield* fs.symlink(
      path.dirname(require.resolve("web-features")),
      path.join(source, "node_modules/web-features")
    );
    yield* fs.writeFileString(
      path.join(source, "node_modules/other/package.json"),
      JSON.stringify({ dependencies: { "web-features": "*" }, name: "other" })
    );
    const reviewed = yield* reviewVendorData(
      "lighthouse",
      path.resolve("node_modules/lighthouse"),
      ["web-features"]
    );
    expect(reviewed.dependencies).toEqual([]);
    expect(
      (yield* reviewVendorData("other", source, ["web-features"])).dependencies
    ).toEqual(["web-features"]);
    yield* vendorPackages(["other", ...reviewed.dependencies], source, output);
    expect(
      yield* fs.exists(path.join(output, "node_modules/web-features/data.json"))
    ).toBe(true);
    expect(
      yield* fs.exists(
        path.join(output, "node_modules/web-features/LICENSE.txt")
      )
    ).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "requires a new review for changed consumers, new dynamic loaders, versions and exports",
  () =>
    Effect.gen(function* changedConsumers() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "vendor-data-guard-",
      });
      const copy = (relative: string): Effect.Effect<void, PlatformError> =>
        Effect.gen(function* copyConsumers() {
          yield* fs.makeDirectory(path.join(directory, relative), {
            recursive: true,
          });
          for (const entry of yield* fs.readDirectory(
            path.join(thirdParty, relative)
          )) {
            if (entry === "node_modules") {
              continue;
            }
            const child = path.join(relative, entry);
            const info = yield* fs.stat(path.join(thirdParty, child));
            if (info.type === "Directory") {
              yield* copy(child);
            } else if (
              /\.(?:c|m)?js$/u.test(child) ||
              entry === "package.json"
            ) {
              yield* fs.copyFile(
                path.join(thirdParty, child),
                path.join(directory, child)
              );
            }
          }
        });
      yield* copy("");
      yield* fs.writeFileString(
        path.join(directory, "dist/domain-map.csv"),
        "unused"
      );
      expect(
        (yield* reviewVendorData("third-party-web", directory, [])).excluded
      ).toContain("dist/domain-map.csv");
      for (const code of [
        "import('../dist/domain-map.csv');",
        "require('node:module').createRequire(__filename)('../dist/domain-map.csv');",
        "require('node:fs').readFileSync('../dist/domain-map.csv');",
      ]) {
        yield* fs.writeFileString(path.join(directory, "new.cjs"), code);
        const error = yield* reviewVendorData(
          "third-party-web",
          directory,
          []
        ).pipe(Effect.flip);
        expect(error.message).toContain("consumers changed");
      }
      yield* fs.remove(path.join(directory, "new.cjs"));
      const manifestPath = path.join(directory, "package.json");
      const original = yield* fs.readFileString(manifestPath);
      for (const changed of [
        original.replace('"version": "0.30.0"', '"version": "0.31.0"'),
        original.replace("{", '{"exports": "./dist/domain-map.csv",'),
      ]) {
        yield* fs.writeFileString(manifestPath, changed);
        const error = yield* reviewVendorData(
          "third-party-web",
          directory,
          []
        ).pipe(Effect.flip);
        expect(error.message).toContain("consumers changed");
      }
      yield* fs.writeFileString(manifestPath, original);
      yield* fs.writeFileString(
        path.join(directory, "lib/index.js"),
        "module.exports = require('../dist/domain-map.csv');"
      );
      const error = yield* reviewVendorData(
        "third-party-web",
        directory,
        []
      ).pipe(Effect.flip);
      expect(error.message).toContain("consumers changed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.effect(
  "omits reviewed browser artifacts while preserving engines and licenses",
  () =>
    Effect.gen(function* browserArtifacts() {
      const fs = yield* FileSystem.FileSystem;
      const output = yield* fs.makeTempDirectoryScoped({
        prefix: "vendor-browser-",
      });
      yield* vendorPackages(
        ["playwright-core", "puppeteer-core"],
        process.cwd(),
        output
      );
      for (const relative of [
        "playwright-core/lib/vite/htmlReport",
        "puppeteer-core/lib/es5-iife",
      ]) {
        expect(
          yield* fs.exists(path.join(output, "node_modules", relative))
        ).toBe(false);
      }
      for (const relative of [
        "playwright-core/lib/coreBundle.js",
        "playwright-core/lib/server",
        "playwright-core/lib/vite/recorder/index.html",
        "playwright-core/lib/vite/traceViewer/index.html",
        "playwright-core/lib/vite/dashboard/index.html",
        "playwright-core/LICENSE",
        "playwright-core/NOTICE",
        "puppeteer-core/lib/puppeteer/puppeteer-core.js",
      ]) {
        expect(
          yield* fs.exists(path.join(output, "node_modules", relative)),
          relative
        ).toBe(true);
      }
      // The installed Puppeteer tarball has inline license headers, no LICENSE.
      expect(
        yield* fs.readFileString(
          path.join(
            output,
            "node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js"
          )
        )
      ).toContain("SPDX-License-Identifier: Apache-2.0");
      const manifest = yield* fs.readFileString(
        path.join(output, "node_modules/puppeteer-core/package.json")
      );
      expect(manifest).not.toContain("es5-iife");
      expect(manifest).not.toContain('"wireit":');
      expect(manifest).toContain('"./lib/puppeteer/puppeteer-core.js"');
      for (const [name, excluded] of [
        ["playwright-core", "lib/vite/htmlReport"],
        ["puppeteer-core", "lib/es5-iife"],
      ] as const) {
        const source = path.resolve("node_modules", name);
        expect((yield* reviewVendorData(name, source, [])).excluded).toEqual([
          excluded,
        ]);
        const changed = yield* fs.makeTempDirectoryScoped({
          prefix: "vendor-browser-guard-",
        });
        yield* fs.makeDirectory(path.join(changed, excluded), {
          recursive: true,
        });
        yield* fs.copyFile(
          path.join(source, "package.json"),
          path.join(changed, "package.json")
        );
        yield* fs.writeFileString(
          path.join(changed, "new.cjs"),
          `require('node:fs').readFileSync('${excluded}/index.js');`
        );
        const error = yield* reviewVendorData(name, changed, []).pipe(
          Effect.flip
        );
        expect(error.message).toContain("consumers changed");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
