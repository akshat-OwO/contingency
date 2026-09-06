import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { publishableManifests } from "../src/publishable-packages.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

const readManifest = async (relativePath: string) => {
  const text = await readFile(path.join(repoRoot, relativePath), "utf-8");
  return JSON.parse(text) as Record<string, unknown>;
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

    expect(typeof bin === "object" && bin !== null).toBe(true);

    for (const [name, target] of Object.entries(
      bin as Record<string, unknown>
    )) {
      expect(typeof target).toBe("string");
      expect(
        (target as string).startsWith("./"),
        `bin.${name} is "${String(target)}"; npm strips a leading './' on publish and the command disappears`
      ).toBe(false);
    }
  });

  it("is not private, or it would never reach the registry", async () => {
    const manifest = await readManifest(relativePath);
    expect(manifest.private).not.toBe(true);
  });
});
