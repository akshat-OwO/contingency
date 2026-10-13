// Builds the working, changed, and broken fixture APKs from the committed lockfile.
// Sources are copied to an owned directory outside the repository, because nub
// resolves any package under the repository to the root workspace.
/* oxlint-disable eslint/no-await-in-loop */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const fixture = path.resolve(import.meta.dirname, "..");
const repository = path.resolve(fixture, "../../../../..");
const variants = ["working", "changed", "broken"];
const { values } = parseArgs({
  options: {
    out: {
      default: path.join(
        repository,
        ".cursor/skills/verify-contingency/artifacts/android-checkout/builds"
      ),
      type: "string",
    },
    variant: { default: "all", type: "string" },
  },
});
const selected = values.variant === "all" ? variants : [values.variant];
if (!selected.every((variant) => variants.includes(variant))) {
  throw new Error(`--variant must be all or one of ${variants.join(", ")}`);
}
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (sdk === undefined) {
  throw new Error("Export ANDROID_HOME to the Android SDK.");
}
if (process.env.JAVA_HOME === undefined) {
  throw new Error("Export JAVA_HOME to a JDK 17 installation.");
}

const run = async (file, args, options) => {
  let stdout = "";
  const child = spawn(file, args, {
    ...options,
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stderr.write(chunk);
  });
  // `once` rejects when the process cannot start.
  const [code] = await once(child, "close");
  if (code !== 0) {
    throw new Error(`${file} ${args.join(" ")} exited ${code}`);
  }
  return stdout;
};

const javaVersion = /^JAVA_VERSION="(?<version>[^"]+)"/mu.exec(
  await readFile(path.join(process.env.JAVA_HOME, "release"), "utf-8")
)?.groups?.version;
if (!javaVersion?.startsWith("17.")) {
  throw new Error(`JAVA_HOME must be JDK 17; found ${javaVersion}.`);
}
const lockfile = await readFile(path.join(fixture, "nub.lock"));
const lockHash = createHash("sha256").update(lockfile).digest("hex");
const work = path.join(
  tmpdir(),
  `contingency-android-checkout-${lockHash.slice(0, 12)}`
);
await mkdir(work, { recursive: true });
for (const entry of [
  ".npmrc",
  "app.config.js",
  "index.js",
  "nub.lock",
  "package.json",
  "src",
]) {
  await rm(path.join(work, entry), { force: true, recursive: true });
  await cp(path.join(fixture, entry), path.join(work, entry), {
    recursive: true,
  });
}
// React Native and Expo Gradle scripts resolve packages from a hoisted node_modules.
await run("nub", ["install", "--frozen-lockfile", "--node-linker", "hoisted"], {
  cwd: work,
});
await mkdir(values.out, { recursive: true });

// Expo's Gradle scripts spawn `node` from PATH. Give them this real Node binary
// without the runner's preload, shim, or TypeScript configuration handling.
const nodeEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("__NUB_") &&
      !["NODE_COMPILE_CACHE", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
);
nodeEnvironment.PATH = [
  path.dirname(process.execPath),
  ...(process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => !path.basename(entry).startsWith("nub-node-shim")),
].join(path.delimiter);

const builds = [];
for (const variant of selected) {
  const env = { ...nodeEnvironment, CI: "1", FIXTURE_VARIANT: variant };
  await run(
    "nub",
    [
      "exec",
      "expo",
      "prebuild",
      "--platform",
      "android",
      "--clean",
      "--no-install",
    ],
    { cwd: work, env }
  );
  await run(
    "./gradlew",
    ["assembleRelease", "--no-daemon", "-PreactNativeArchitectures=arm64-v8a"],
    { cwd: path.join(work, "android"), env }
  );
  const apk = path.join(values.out, `${variant}.apk`);
  await cp(
    path.join(work, "android/app/build/outputs/apk/release/app-release.apk"),
    apk
  );
  const bytes = await readFile(apk);
  const badging = await run(
    path.join(sdk, "build-tools/36.0.0/aapt"),
    ["dump", "badging", apk],
    { env }
  );
  const identity =
    /^package: name='(?<appId>[^']+)' versionCode='(?<appBuild>\d+)' versionName='(?<versionName>[^']+)'/mu.exec(
      badging
    )?.groups;
  if (identity === undefined) {
    throw new Error(`Could not read the package identity of ${apk}.`);
  }
  builds.push({
    ...identity,
    apk,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    variant,
  });
}
const manifest = {
  builds,
  java: javaVersion,
  lockfileSha256: lockHash,
};
await writeFile(
  path.join(values.out, "builds.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
