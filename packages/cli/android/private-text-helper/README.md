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
