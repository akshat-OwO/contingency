import { createRequire } from "node:module";
import path from "node:path";

import { Effect, FileSystem, Schema } from "effect";
import type { PlatformError } from "effect/PlatformError";

const Dependencies = Schema.Record(Schema.String, Schema.String);
const Manifest = Schema.Struct({
  dependencies: Schema.optional(Dependencies),
  optionalDependencies: Schema.optional(Dependencies),
  peerDependencies: Schema.optional(Dependencies),
  peerDependenciesMeta: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ optional: Schema.optional(Schema.Boolean) })
    )
  ),
});

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
  ): Effect.Effect<void, Error | PlatformError> =>
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
      for (const entry of yield* fs.readDirectory(source)) {
        if (entry !== "node_modules") {
          yield* fs.copy(path.join(source, entry), path.join(target, entry));
        }
      }
      const text = yield* fs.readFileString(path.join(source, "package.json"));
      const manifest = yield* Effect.try({
        catch: (cause) =>
          new Error(`Invalid vendor manifest at ${source}`, { cause }),
        try: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(text)),
      });
      const optional = manifest.optionalDependencies ?? {};
      const peers = manifest.peerDependencies ?? {};
      const dependencies = { ...peers, ...manifest.dependencies, ...optional };
      for (const dependency of Object.keys(dependencies)) {
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
