import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { applyReleaseVersion } from "../src/apply-version.ts";
import { publishableManifests } from "../src/publishable-packages.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(Effect.provide(effect, NodeServices.layer));

const makeRepo = async (manifest: Record<string, unknown>) => {
  const root = await mkdtemp(path.join(tmpdir(), "contingency-release-"));
  await Promise.all(
    publishableManifests.map(async (relativePath) => {
      const filePath = path.join(root, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
    })
  );
  return root;
};

const readManifest = async (root: string) => {
  const text = await readFile(
    path.join(root, publishableManifests[0]),
    "utf-8"
  );
  return JSON.parse(text) as Record<string, unknown>;
};

describe("applyReleaseVersion", () => {
  it("writes the version into every publishable manifest", async () => {
    const root = await makeRepo({
      name: "@contingencyhq/cli",
      version: "0.0.1",
    });

    const updated = await run(applyReleaseVersion("1.2.3", root));

    expect(updated).toStrictEqual([...publishableManifests]);
    const stamped = await readManifest(root);
    expect(stamped.version).toBe("1.2.3");
  });

  it("preserves every other field and the key order", async () => {
    const root = await makeRepo({
      bin: { contingency: "./dist/index.js" },
      name: "@contingencyhq/cli",
      version: "0.0.1",
    });

    await run(applyReleaseVersion("1.2.3", root));

    const stamped = await readManifest(root);
    expect(Object.keys(stamped)).toStrictEqual(["bin", "name", "version"]);
    expect(stamped.bin).toStrictEqual({ contingency: "./dist/index.js" });
  });

  it("reports nothing updated when the version already matches", async () => {
    const root = await makeRepo({
      name: "@contingencyhq/cli",
      version: "1.2.3",
    });

    expect(await run(applyReleaseVersion("1.2.3", root))).toStrictEqual([]);
  });

  it("removes workspace dependencies npm cannot resolve", async () => {
    const root = await makeRepo({
      dependencies: {
        "@contingency/protocol": "workspace:*",
        effect: "^4.0.0",
      },
      devDependencies: { "@contingency/protocol": "workspace:*" },
      name: "@contingencyhq/cli",
      version: "0.0.1",
    });

    await run(applyReleaseVersion("1.2.3", root));

    const stamped = await readManifest(root);
    expect(stamped.dependencies).toStrictEqual({ effect: "^4.0.0" });
    // The field went empty, so it is dropped rather than left as `{}`.
    expect(stamped).not.toHaveProperty("devDependencies");
  });

  it("strips workspace dependencies even when the version already matches", async () => {
    const root = await makeRepo({
      dependencies: { "@contingency/protocol": "workspace:*" },
      name: "@contingencyhq/cli",
      version: "1.2.3",
    });

    expect(await run(applyReleaseVersion("1.2.3", root))).toStrictEqual([
      ...publishableManifests,
    ]);

    const stamped = await readManifest(root);
    expect(stamped).not.toHaveProperty("dependencies");
  });

  it("removes catalog ranges, which only nub resolves", async () => {
    const root = await makeRepo({
      devDependencies: { typescript: "catalog:", vitest: "catalog:effect" },
      name: "@contingencyhq/cli",
      version: "0.0.1",
    });

    await run(applyReleaseVersion("1.2.3", root));

    const stamped = await readManifest(root);
    expect(stamped).not.toHaveProperty("devDependencies");
  });

  it("leaves ordinary ranges alone", async () => {
    const root = await makeRepo({
      dependencies: { effect: "^4.0.0", "playwright-core": "^1.62.1" },
      name: "@contingencyhq/cli",
      version: "0.0.1",
    });

    await run(applyReleaseVersion("1.2.3", root));

    const stamped = await readManifest(root);
    expect(stamped.dependencies).toStrictEqual({
      effect: "^4.0.0",
      "playwright-core": "^1.62.1",
    });
  });

  it("fails when a manifest is missing rather than publishing 0.0.1", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "contingency-release-"));

    await expect(run(applyReleaseVersion("1.2.3", root))).rejects.toThrow();
  });
});
