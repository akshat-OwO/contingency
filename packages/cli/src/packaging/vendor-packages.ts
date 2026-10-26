import { createRequire } from "node:module";
import path from "node:path";

import { Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { vendorEnglishLocales } from "./vendor-locales.ts";
import { lighthouseRuntimeDependencies } from "./vendor-sentry.ts";

type RuntimeTarget =
  | string
  | null
  | readonly RuntimeTarget[]
  | { readonly [key: string]: RuntimeTarget };
const RuntimeTargetSchema: Schema.Codec<RuntimeTarget> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    Schema.Null,
    Schema.Array(RuntimeTargetSchema),
    Schema.Record(Schema.String, RuntimeTargetSchema),
  ])
);

const Dependencies = Schema.Record(Schema.String, Schema.String);
const Manifest = Schema.Struct({
  bin: Schema.optional(RuntimeTargetSchema),
  dependencies: Schema.optional(Dependencies),
  exports: Schema.optional(RuntimeTargetSchema),
  imports: Schema.optional(RuntimeTargetSchema),
  main: Schema.optional(Schema.String),
  module: Schema.optional(Schema.String),
  optionalDependencies: Schema.optional(Dependencies),
  peerDependencies: Schema.optional(Dependencies),
  peerDependenciesMeta: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ optional: Schema.optional(Schema.Boolean) })
    )
  ),
  version: Schema.optional(Schema.String),
});

const typeScriptFile = /\.(?:ts|mts|cts)$/u;

// Consider every export condition, including custom conditions such as
// @zod/source. Keep the whole TS tree when an entry can load it, since its
// imports may reach other TS files. `types` conditions are compiler-only.
export const hasTypeScriptRuntime = (value: RuntimeTarget): boolean => {
  if (Schema.is(Schema.String)(value)) {
    return typeScriptFile.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasTypeScriptRuntime);
  }
  if (value !== null) {
    return Object.entries(value).some(
      ([key, target]) => key !== "types" && hasTypeScriptRuntime(target)
    );
  }
  return false;
};

/** Paths are relative to a package; directories use the same predicate. */
export const shouldVendorFile = (
  relative: string,
  preserveTypeScript = false
): boolean =>
  !relative.split(path.sep).includes("node_modules") &&
  !relative.endsWith(".map") &&
  (preserveTypeScript || !typeScriptFile.test(relative));

/** Preserve asset paths without shipping Nub's external store symlinks. */
export const vendorPackages = Effect.fn("vendorPackages")(function* vendor(
  names: readonly string[],
  sourceRoot: string,
  outputRoot: string
) {
  const fs = yield* FileSystem.FileSystem;
  const placed = new Map<string, string>();
  const copied = new Set<string>();
  const rootModules = path.join(outputRoot, "node_modules");

  const resolve = Effect.fn("resolveVendorPackage")(function* resolvePackage(
    name: string,
    parent: string,
    optional: boolean
  ) {
    if (name.startsWith("@types/")) {
      return;
    }
    const search =
      createRequire(path.join(parent, "package.json")).resolve.paths(name) ??
      [];
    for (const directory of search) {
      const candidate = path.join(directory, name);
      if (yield* fs.exists(path.join(candidate, "package.json"))) {
        return yield* fs.realPath(candidate);
      }
    }
    if (optional) {
      return;
    }
    return yield* Effect.fail(
      new Error(`Cannot vendor ${name} from ${parent}`)
    );
  });

  const copy = (
    name: string,
    source: string,
    parentTarget: string
  ): Effect.Effect<void, Error | PlatformError, FileSystem.FileSystem> =>
    Effect.gen(function* copyPackage() {
      // Reuse the nearest matching package, but nest a conflicting version.
      // Recording before recursion also handles dependency and peer cycles.
      let target = path.join(rootModules, name);
      let ancestor = parentTarget;
      while (ancestor.startsWith(outputRoot)) {
        const candidate = path.join(ancestor, "node_modules", name);
        const existing = placed.get(candidate);
        if (existing === source) {
          if (copied.has(candidate)) {
            return;
          }
          target = candidate;
          break;
        }
        if (existing !== undefined) {
          target = path.join(parentTarget, "node_modules", name);
          break;
        }
        if (ancestor === outputRoot) {
          break;
        }
        ancestor = path.dirname(ancestor);
      }
      placed.set(target, source);
      copied.add(target);
      yield* fs.makeDirectory(target, { recursive: true });
      const text = yield* fs.readFileString(path.join(source, "package.json"));
      const manifest = yield* Effect.try({
        catch: (cause) =>
          new Error(`Invalid vendor manifest at ${source}`, { cause }),
        try: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(text)),
      });
      const preserveTypeScript = hasTypeScriptRuntime([
        manifest.main ?? null,
        manifest.module ?? null,
        manifest.exports ?? null,
        manifest.imports ?? null,
        manifest.bin ?? null,
      ]);
      const copyFiles = (
        relative: string
      ): Effect.Effect<void, PlatformError> =>
        Effect.gen(function* copyDirectory() {
          const from = path.join(source, relative);
          const to = path.join(target, relative);
          yield* fs.makeDirectory(to, { recursive: true });
          for (const entry of yield* fs.readDirectory(from)) {
            const child = path.join(relative, entry);
            if (!shouldVendorFile(child, preserveTypeScript)) {
              continue;
            }
            const info = yield* fs.stat(path.join(source, child));
            yield* info.type === "Directory"
              ? copyFiles(child)
              : fs.copy(path.join(source, child), path.join(target, child));
          }
        });
      yield* copyFiles("");
      yield* vendorEnglishLocales(name, manifest.version, target);
      const optional = manifest.optionalDependencies ?? {};
      const peers = manifest.peerDependencies ?? {};
      const dependencies = { ...peers, ...manifest.dependencies, ...optional };
      // Traverse the retained graph after removing only Lighthouse's reviewed
      // Sentry edges. Dependencies exclusive to those edges are never copied;
      // shared dependencies (including Sentry itself) remain reachable from
      // other roots, dependencies, optional dependencies or peers.
      const retained = yield* lighthouseRuntimeDependencies(
        name,
        manifest.version,
        Object.keys(dependencies),
        source
      );
      for (const dependency of retained) {
        const resolved = yield* resolve(
          dependency,
          source,
          dependency in optional ||
            (manifest.peerDependenciesMeta?.[dependency]?.optional === true &&
              !(dependency in (manifest.dependencies ?? {})))
        );
        if (resolved !== undefined) {
          yield* copy(dependency, resolved, target);
        }
      }
    });

  // Reserve entry packages before hoisting their dependencies, so a transitive
  // version cannot occupy an entry package's slot.
  const entries: { readonly name: string; readonly source: string }[] = [];
  for (const name of names) {
    const source = yield* resolve(name, sourceRoot, false);
    if (source !== undefined) {
      entries.push({ name, source });
      placed.set(path.join(rootModules, name), source);
    }
  }
  for (const { name, source } of entries) {
    yield* copy(name, source, outputRoot);
  }
});
