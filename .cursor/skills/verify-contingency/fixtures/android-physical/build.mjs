import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const source = import.meta.dirname;
const sdk = process.env.ANDROID_HOME;
const java = process.env.JAVA_HOME;
if (!sdk || !java) {
  throw new Error(
    "Export ANDROID_HOME and JAVA_HOME for Android API 36 and JDK 17."
  );
}
const tools = path.join(sdk, "build-tools/36.0.0");
const owned = await mkdtemp(
  path.join(tmpdir(), "contingency-physical-fixture-")
);
const output = path.resolve(source, "../../artifacts/android-physical/build");
try {
  await Promise.all(
    ["build.gradle", "settings.gradle"].map((name) =>
      copyFile(path.join(source, name), path.join(owned, name))
    )
  );
  await writeFile(
    path.join(owned, "gradle.properties"),
    "android.useAndroidX=true\norg.gradle.jvmargs=-Xmx1g\n"
  );
  await execute(
    path.resolve(
      source,
      "../../../../../packages/cli/android/private-text-helper/gradlew"
    ),
    [
      "--no-daemon",
      "--quiet",
      "--project-dir",
      owned,
      `-PfixtureSource=${source}`,
      "assembleRelease",
    ],
    { env: { ...process.env, JAVA_HOME: java }, maxBuffer: 8 * 1024 * 1024 }
  );
  const aligned = path.join(
    owned,
    "build/outputs/apk/release/contingency-physical-fixture-release-unsigned.apk"
  );
  const key = path.join(owned, "fixture.jks");
  await execute(path.join(java, "bin/keytool"), [
    "-genkeypair",
    "-keystore",
    key,
    "-storepass",
    "fixture-only",
    "-keypass",
    "fixture-only",
    "-alias",
    "fixture",
    "-dname",
    "CN=Disposable Contingency fixture",
    "-keyalg",
    "RSA",
    "-validity",
    "30",
  ]);
  await mkdir(output, { recursive: true });
  const apk = path.join(output, "fixture.apk");
  await execute(
    path.join(tools, "apksigner"),
    [
      "sign",
      "--ks",
      key,
      "--ks-pass",
      "pass:fixture-only",
      "--out",
      apk,
      aligned,
    ],
    { env: { ...process.env, JAVA_HOME: java } }
  );
  const sha256 = createHash("sha256")
    .update(await readFile(apk))
    .digest("hex");
  await writeFile(
    path.join(output, "build.json"),
    `${JSON.stringify({ apk, package: "dev.contingency.physicalfixture", sha256, versionCode: 1 }, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify({ apk, sha256 })}\n`);
} finally {
  await rm(owned, { force: true, recursive: true });
}
