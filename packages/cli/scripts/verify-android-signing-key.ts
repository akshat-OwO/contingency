import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { androidPrivateTextRelease } from "../src/services/android-runtime-contract.ts";

const execute = promisify(execFile);
const keystore = process.env.CONTINGENCY_ANDROID_SIGNING_KEYSTORE;
const passwordFile = process.env.CONTINGENCY_ANDROID_SIGNING_PASSWORD_FILE;
const sdk = process.env.ANDROID_HOME;
const original = fileURLToPath(
  new URL(
    `../android/private-text-helper/release/contingency-private-text-${androidPrivateTextRelease.version}.apk`,
    import.meta.url
  )
);
const failure = () =>
  new Error(
    "Signing-key verification failed; check the restored key, password file, and SDK without printing them."
  );

// Sign a disposable copy: no helper release, device installation, or key rotation.
Effect.scoped(
  Effect.gen(function* verifyKey() {
    if (!keystore || !passwordFile || !sdk) {
      return yield* Effect.fail(
        new Error(
          "Set ANDROID_HOME, CONTINGENCY_ANDROID_SIGNING_KEYSTORE, and CONTINGENCY_ANDROID_SIGNING_PASSWORD_FILE."
        )
      );
    }
    const directory = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: failure,
        try: () => mkdtemp(path.join(tmpdir(), "contingency-signing-proof-")),
      }),
      (owned) =>
        Effect.tryPromise({
          catch: failure,
          try: () => rm(owned, { force: true, recursive: true }),
        }).pipe(Effect.orDie)
    );
    const signed = path.join(directory, "proof.apk");
    const signer = path.join(sdk, "build-tools/36.0.0/apksigner");
    yield* Effect.tryPromise({
      catch: failure,
      try: (signal) =>
        execute(
          signer,
          [
            "sign",
            "--ks",
            keystore,
            "--ks-key-alias",
            "contingency",
            "--ks-pass",
            `file:${passwordFile}`,
            "--out",
            signed,
            original,
          ],
          { maxBuffer: 1024 * 1024, signal, timeout: 30_000 }
        ),
    });
    const { stdout } = yield* Effect.tryPromise({
      catch: failure,
      try: (signal) =>
        execute(signer, ["verify", "--print-certs", signed], {
          maxBuffer: 1024 * 1024,
          signal,
          timeout: 30_000,
        }),
    });
    const certificate =
      /certificate SHA-256 digest: (?<digest>[0-9a-f]{64})/u.exec(stdout)
        ?.groups?.digest;
    if (certificate !== androidPrivateTextRelease.signingCertificateSha256) {
      return yield* Effect.fail(
        new Error(
          "Restored signing key does not match the pinned helper certificate."
        )
      );
    }
    return {
      signerMatches: true,
      signingCertificateSha256: certificate,
      signingRoundTrip: true,
    };
  })
).pipe(
  Effect.tap((receipt) =>
    Effect.sync(() =>
      process.stdout.write(
        `${JSON.stringify({ ...receipt, temporaryFilesRemoved: true })}\n`
      )
    )
  ),
  NodeRuntime.runMain
);
