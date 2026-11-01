// Adapt package-manager metadata on an older base without changing product sources.
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const readManifest = async (directory) =>
  JSON.parse(await readFile(path.join(directory, "package.json"), "utf-8"));
const head = await readManifest(process.cwd());
const base = await readManifest(root);
if (!base.packageManager.startsWith("pnpm@")) {
  const [previous] = base.packageManager.split("@");
  const { workspaces } = base;
  if (!workspaces?.packages || !workspaces.catalogs) {
    throw new Error("Cannot adapt this base's workspace metadata.");
  }
  await copyFile(
    path.join(root, `${previous}.lock`),
    path.join(root, "pnpm-lock.yaml")
  );
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    `${JSON.stringify(
      {
        allowBuilds: { esbuild: true, "node-datachannel": false },
        catalog: workspaces.catalog,
        catalogs: workspaces.catalogs,
        packages: workspaces.packages,
      },
      null,
      2
    )}\n`
  );
  delete base.workspaces;
  base.packageManager = head.packageManager;
  base.devEngines = head.devEngines;
  base.devDependencies["vite-plus"] = head.devDependencies["vite-plus"];
  const directories = [
    ".",
    "apps/web",
    "packages/cli",
    "packages/protocol",
    "packages/release",
    "packages/lint-rules",
  ];
  await Promise.all(
    directories.map(async (directory) => {
      const manifest =
        directory === "."
          ? base
          : await readManifest(path.join(root, directory));
      for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
        manifest.scripts[name] = script
          .replaceAll(
            `${previous} run --cwd ../../apps/web build`,
            "vp run --filter @contingency/web build"
          )
          .replaceAll(`${previous} exec `, "vp exec ")
          .replaceAll(`${previous} run `, "vp run ")
          .replaceAll(`${previous} watch `, "vpx --watch ")
          .replaceAll(`${previous} `, "vpx ");
      }
      await writeFile(
        path.join(root, directory, "package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`
      );
    })
  );
}
