# Android checkout fixture

An Expo app with one Target App identity, `dev.contingency.checkout`, and three builds. The shopper signs in with a public name, adds an Anvil to the cart, and places a mock order. It takes no password, payment, or network access. All state is in memory, so restarting the activity returns to a fresh sign-in screen.

| Variant | versionCode | Observable outcome |
| --- | --- | --- |
| `working` | 1 | `Order confirmed` |
| `changed` | 2 | Adds a `Spring sale: free mock shipping` banner, a Feather product above the Anvil, and a shipping line. Still ends at `Order confirmed`. |
| `broken` | 3 | Ends at `Checkout failed` with `Mock payment service unavailable. No order was placed.` |

Contingency compares the versionCode as `appBuild`, so a Run against `changed` or `broken` shows an `appBuild` difference and needs Run Environment Permission.

## Semantic handles

agent-device reports these roles and names. Declare them exactly in Workspace.

- Starting condition: `group` `Fixture Shop sign in`
- Public field: `text-field` `Shopper name`. After a fill, its name becomes the entered text.
- Reversible actions: `button` `Sign in`, `button` `Add Anvil to cart`, `button` `Open cart`, `button` `Place mock order`
- Required outcome: `group` `Order confirmed`

## Build

Prerequisites: Node 24, nub 0.9.0, JDK 17 (`JAVA_HOME`), and an Android SDK (`ANDROID_HOME`) with build-tools 36.0.0, platform 36, and NDK 27.1.12297006.

```sh
JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=$HOME/Library/Android/sdk \
  nub .cursor/skills/verify-contingency/fixtures/android-checkout/scripts/build.mjs
```

The script copies these sources to a temporary directory named after the `nub.lock` hash. nub resolves any package inside this repository to the root workspace, so the fixture installs outside it. The script then runs `nub install --frozen-lockfile --node-linker hoisted`, `expo prebuild --clean`, and `gradlew assembleRelease` for `arm64-v8a` once per variant. It writes `working.apk`, `changed.apk`, `broken.apk`, and `builds.json` to `artifacts/android-checkout/builds/`. Pass `--variant <name>` to build one variant, or `--out <dir>` to change the output directory.

`builds.json` records each APK's package, versionCode, versionName, and SHA-256, together with the JDK version and lockfile hash. The proof refuses an APK whose hash no longer matches. Builds are not byte-for-byte reproducible: the Hermes bundle differs between builds of the same source. Rebuilding therefore produces new hashes, and the proof uses whichever `builds.json` is current. Release builds use the React Native debug key. They are fixture builds, not releases.

Pinned versions: Expo SDK 57.0.27, React Native 0.86.3, and React 19.2.3. nub's `no-downgrade` trust policy rejects the Expo SDK 57 backports, which were published before Expo adopted trusted publishing. `.npmrc` exempts only those exact versions.

## Install and reset

The proof installs the variant it needs on the selected emulator. Because release builds cannot downgrade in place, it uninstalls only `dev.contingency.checkout` before installing a lower versionCode. A Run's preparation force-stops the app and restarts `dev.contingency.checkout/.MainActivity`. That is the whole reset procedure; no device data outside this package is touched. At the end, the proof uninstalls the fixture only when it installed it.

The result screen also displays `Shopper: <submitted name>` for independent interface-evaluation device readback. Rebuild and reinstall the working fixture before using that check.
