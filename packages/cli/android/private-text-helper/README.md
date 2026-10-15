# Android private text helper

`dev.contingency.privatetext` enters one private Variable into one observed field, then exits. The experimental Android runtime starts it only for Runs that require `private-input`. The [private text report](../../../../docs/reports/android-private-text.md) describes its protocol and evidence.

The runtime installs only the committed `release/contingency-private-text-<version>.apk`. `release/manifest.json` and `androidPrivateTextRelease` in `src/services/android-runtime-contract.ts` pin its SHA-256 and signing certificate digest. Packaging copies `release/` to `dist/android/private-text-helper/`.

## Build a release

Prerequisites: JDK 17 or newer, an Android SDK with platform 36 and build-tools 36.0.0, and the Contingency release keystore. Never commit the keystore or its password.

1. Change the source. To publish a changed helper, raise `versionCode` and `versionName` in `build.gradle`. Raise `version` and `versionCode` in `androidPrivateTextRelease` to match.
2. Build and sign from the repository root:

   ```sh
   ANDROID_HOME="$HOME/Library/Android/sdk" \
   CONTINGENCY_ANDROID_SIGNING_KEYSTORE=/path/to/contingency-release.jks \
   CONTINGENCY_ANDROID_SIGNING_PASSWORD_FILE=/path/to/password \
     nub packages/cli/scripts/build-android-private-text-helper.ts
   ```

   The script passes the password to Gradle through its environment. It copies the signed APK into `release/` and writes `release/manifest.json`.

3. Copy `sha256` and `signingCertificateSha256` from the manifest into `androidPrivateTextRelease`.
4. Run the [verify-contingency Android private text recipe](../../../../.cursor/skills/verify-contingency/features/workspace.md#android-private-text) on the emulator.

A device holding a helper signed by another key cannot be upgraded in place. Uninstall the helper first, with the device owner's consent.

## Signing-key custody and restore

Keep the existing release key and its password in the maintainer's private Bitwarden vault. Use a Secure Note named **Contingency Android release signing**, with the keystore as an attachment or base64 in the note and its password in a hidden custom field. Record alias `contingency` and the certificate SHA-256 from `release/manifest.json`. Base64 is an encoding; the vault supplies encryption. A JSON export includes note contents but excludes file attachments, so an attachment backup needs a separate export. See [Bitwarden exports](https://bitwarden.com/help/export-your-data/).

The local `~/.config/contingency/android-signing/` files are the working copy. Custody is complete only after importing the backup and validating a restored copy, with account recovery available independently of this machine. The repository records the public signer and restore procedure, never the key, password, or vault export.

Download or decode the backed-up keystore into a private temporary directory and save the password as a private file. Verify the actual private key by signing a disposable copy of the existing APK:

```sh
ANDROID_HOME=/path/to/android-sdk \
CONTINGENCY_ANDROID_SIGNING_KEYSTORE=/private/restore/contingency-release.jks \
CONTINGENCY_ANDROID_SIGNING_PASSWORD_FILE=/private/restore/password \
  nub packages/cli/scripts/verify-android-signing-key.ts
```

Done when `signingRoundTrip`, `signerMatches`, and `temporaryFilesRemoved` are true and the certificate equals the committed manifest. The verifier changes no release bytes or device state, passes only the password-file path to the signer, and sanitizes signer errors. Delete temporary restored files and any plaintext import/export after verification. A successful check of the working copy alone does not prove the vault backup.
