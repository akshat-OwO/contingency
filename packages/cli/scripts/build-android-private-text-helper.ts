import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { androidPrivateTextRelease } from "../src/services/android-runtime-contract.ts";

const execute = promisify(execFile);
const project = fileURLToPath(
  new URL("../android/private-text-helper/", import.meta.url)
);
const release = path.join(project, "release");
const keystore = process.env.CONTINGENCY_ANDROID_SIGNING_KEYSTORE;
const passwordFile = process.env.CONTINGENCY_ANDROID_SIGNING_PASSWORD_FILE;
const sdk = process.env.ANDROID_HOME;
const apkName = `contingency-private-text-${androidPrivateTextRelease.version}.apk`;

/** Builds, signs, and records the one helper release the runtime pins. */
Effect.gen(function* buildHelper() {
  if (!keystore || !passwordFile || !sdk) {
    return yield* Effect.fail(
      new Error(
        "Set ANDROID_HOME, CONTINGENCY_ANDROID_SIGNING_KEYSTORE, and CONTINGENCY_ANDROID_SIGNING_PASSWORD_FILE."
      )
    );
  }
  const password = (yield* Effect.tryPromise(() =>
    readFile(passwordFile, "utf-8")
  )).trim();
  yield* Effect.tryPromise({
    catch: () =>
      new Error(
        "Android helper build failed. Check JDK 17+, SDK 36, and the signing keystore."
      ),
    try: (signal) =>
      execute(
        path.join(project, "gradlew"),
        ["--no-daemon", "--quiet", "assembleRelease"],
        {
          cwd: project,
          // The password reaches Gradle through its environment, never argv.
          env: {
            ...process.env,
            CONTINGENCY_ANDROID_SIGNING_ALIAS: "contingency",
            CONTINGENCY_ANDROID_SIGNING_KEYSTORE: keystore,
            CONTINGENCY_ANDROID_SIGNING_PASSWORD: password,
          },
          maxBuffer: 8 * 1024 * 1024,
          signal,
        }
      ),
  });
  const built = path.join(
    project,
    "build/outputs/apk/release/contingency-private-text-helper-release.apk"
  );
  const target = path.join(release, apkName);
  yield* Effect.tryPromise(async () => {
    await mkdir(release, { recursive: true });
    await copyFile(built, target);
  });
  const bytes = yield* Effect.tryPromise(() => readFile(target));
  const { stdout } = yield* Effect.tryPromise(() =>
    execute(path.join(sdk, "build-tools/36.0.0/apksigner"), [
      "verify",
      "--print-certs",
      target,
    ])
  );
  const certificate =
    /certificate SHA-256 digest: (?<digest>[0-9a-f]{64})/u.exec(stdout)?.groups
      ?.digest;
  if (certificate === undefined) {
    return yield* Effect.fail(new Error("The built helper is not signed."));
  }
  const manifest = {
    apk: apkName,
    instrumentation: androidPrivateTextRelease.instrumentation,
    packageName: androidPrivateTextRelease.packageName,
    protocol: androidPrivateTextRelease.protocol,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signingCertificateSha256: certificate,
    version: androidPrivateTextRelease.version,
    versionCode: androidPrivateTextRelease.versionCode,
  };
  yield* Effect.tryPromise(() =>
    writeFile(
      path.join(release, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
  );
  yield* Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  });
}).pipe(NodeRuntime.runMain);
