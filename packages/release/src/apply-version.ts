import path from "node:path";

import { Data, Effect, FileSystem, Schema } from "effect";

import { publishableManifests } from "./publishable-packages.ts";

export class ManifestVersionError extends Data.TaggedError(
  "ManifestVersionError"
)<{
  readonly operation: "read" | "parse" | "write";
  readonly filePath: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Failed to ${this.operation} package manifest '${this.filePath}'.`;
  }
}

const PackageManifest = Schema.Record(Schema.String, Schema.Json);
const PackageDependencies = Schema.Record(Schema.String, Schema.String);

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/**
 * Specifier prefixes that only mean something inside this repository.
 * `workspace:` names a sibling package and `catalog:` names a version from the
 * root catalog; nub resolves both, and npm resolves neither.
 */
const LOCAL_ONLY_PREFIXES = ["workspace:", "catalog:"];

/**
 * Strips every dependency whose range only resolves inside this repository,
 * reporting the names it removed.
 *
 * npm rejects an installed package that still carries one of these with
 * `EUNSUPPORTEDPROTOCOL`. Today they all sit in fields npm ignores for an
 * installed dependency, which makes this a latent failure rather than a
 * current one: moving a `catalog:` dependency into `dependencies` would break
 * every install, and nothing else would catch it. Contingency's only workspace
 * dependency is the protocol package, which tsdown inlines into `dist`, so
 * removing these declarations loses nothing the published code needs.
 */
interface StrippedManifest {
  readonly manifest: Schema.JsonObject;
  readonly removed: string[];
}

const stripWorkspaceDependencies = (
  manifest: Schema.JsonObject
): StrippedManifest => {
  const next = { ...manifest };
  const removed: string[] = [];

  for (const field of DEPENDENCY_FIELDS) {
    const decoded = Schema.decodeUnknownOption(PackageDependencies)(
      manifest[field]
    );
    if (decoded._tag === "None") {
      continue;
    }

    const kept = Object.entries(decoded.value).filter(([name, range]) => {
      const isLocalOnly = LOCAL_ONLY_PREFIXES.some((prefix) =>
        range.startsWith(prefix)
      );

      if (isLocalOnly) {
        removed.push(`${field}.${name}`);
      }
      return !isLocalOnly;
    });

    if (kept.length === 0) {
      Reflect.deleteProperty(next, field);
    } else {
      next[field] = Object.fromEntries(kept);
    }
  }

  return { manifest: next, removed };
};

/**
 * Prepares every publishable manifest for release: writes the version, and
 * removes `workspace:` dependencies that would not resolve off this machine.
 *
 * Versions are stamped at build time rather than committed per change, so
 * `main` never carries a number that has not shipped and no pull request has
 * to be rebased over someone else's version bump. The tag is the record of
 * what a release was; the manifest is a build input.
 */
export const applyReleaseVersion = Effect.fn("applyReleaseVersion")(
  function* stampManifests(version: string, rootDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const updated: string[] = [];

    for (const relativePath of publishableManifests) {
      const filePath = path.join(path.resolve(rootDir), relativePath);

      const text = yield* fs
        .readFileString(filePath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManifestVersionError({ cause, filePath, operation: "read" })
          )
        );

      const manifest = yield* Effect.try({
        catch: (cause) =>
          new ManifestVersionError({ cause, filePath, operation: "parse" }),
        try: () => Schema.decodeUnknownSync(PackageManifest)(JSON.parse(text)),
      });

      const stripped = stripWorkspaceDependencies(manifest);

      if (manifest.version === version && stripped.removed.length === 0) {
        continue;
      }

      const stamped = { ...stripped.manifest, version };

      // Two-space indent and a trailing newline, matching what every other
      // tool here writes, so a stamped manifest never shows up as a
      // whitespace-only diff if it is ever committed.
      yield* fs
        .writeFileString(filePath, `${JSON.stringify(stamped, null, 2)}\n`)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ManifestVersionError({ cause, filePath, operation: "write" })
          )
        );

      updated.push(relativePath);
    }

    return updated;
  }
);
