import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const android = path.join(sdk, "platforms/android-36/android.jar");
const owned = await mkdtemp(
  path.join(tmpdir(), "contingency-physical-fixture-")
);
const output = path.resolve(source, "../../artifacts/android-physical/build");
try {
  await mkdir(path.join(owned, "classes"));
  await execute(path.join(java, "bin/javac"), [
    "-classpath",
    android,
    "-d",
    path.join(owned, "classes"),
    path.join(source, "MainActivity.java"),
    path.join(source, "ReplacementActivity.java"),
  ]);
  await execute(
    path.join(tools, "d8"),
    [
      "--lib",
      android,
      "--output",
      owned,
      path.join(
        owned,
        "classes/dev/contingency/physicalfixture/MainActivity.class"
      ),
      path.join(
        owned,
        "classes/dev/contingency/physicalfixture/ReplacementActivity.class"
      ),
    ],
    { env: { ...process.env, JAVA_HOME: java } }
  );
  const unsigned = path.join(owned, "unsigned.apk");
  await execute(path.join(tools, "aapt"), [
    "package",
    "-f",
    "-M",
    path.join(source, "AndroidManifest.xml"),
    "-I",
    android,
    "-F",
    unsigned,
  ]);
  await execute(path.join(tools, "aapt"), ["add", unsigned, "classes.dex"], {
    cwd: owned,
  });
  const aligned = path.join(owned, "aligned.apk");
  await execute(path.join(tools, "zipalign"), ["-f", "4", unsigned, aligned]);
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
