import { readFile } from "node:fs/promises";
import path from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { publishableManifests } from "../src/publishable-packages.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const PublishableManifest = Schema.Struct({
  bin: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  private: Schema.optional(Schema.Boolean),
});

const readManifest = async (relativePath: string) => {
  const text = await readFile(path.join(repoRoot, relativePath), "utf-8");
  return Schema.decodeUnknownSync(PublishableManifest)(JSON.parse(text));
};

describe.each(publishableManifests)("%s", (relativePath) => {
  // npm's publish-time normalization silently DELETES a bin entry whose path
  // starts with "./", so the package installs with no command at all. Neither
  // `npm pack` nor installing the packed tarball reproduces it, because only
  // publish normalizes. This asserts the shape that survives a publish.
  it("declares bin paths without a leading './'", async () => {
    const { bin } = await readManifest(relativePath);

    if (bin === undefined) {
      return;
    }

    for (const [name, target] of Object.entries(bin)) {
      expect(
        target.startsWith("./"),
        `bin.${name} is "${target}"; npm strips a leading './' on publish and the command disappears`
      ).toBe(false);
    }
  });

  it("is not private, or it would never reach the registry", async () => {
    const manifest = await readManifest(relativePath);
    expect(manifest.private).not.toBe(true);
  });
});
