# Physical Android proof fixture

This disposable API 36 app proves app-data preparation and private text without opening Settings on a daily-use phone. Its only requested runtime permission is `POST_NOTIFICATIONS`. It has a native masked password field, an ordinary field, a persistent data marker, and reversible buttons for semantic-action and target-change checks. A replacement activity stays in the same package.

`MaterialPasswordActivity` uses stock Material Components 1.13.0 `TextInputLayout` and `TextInputEditText` with password input type. The screen remains masked. Material's own accessibility delegate exposes the actual editable text, so the existing private helper can compare the field's state internally. The fixture has no readback endpoint or accessibility override. The `filter` intent extra applies an Android `InputFilter` that replaces input with the same number of `x` characters; that fill must remain uncertain. An ordered, package-scoped `REMOVE_PASSWORD` broadcast removes the field and acknowledges completion with result code 1 for the mismatch refusal. This mutation exposes no field value.

Build with JDK 17 and Android SDK platform/build-tools 36:

```sh
JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=/path/to/android-sdk \
  nub .cursor/skills/verify-contingency/fixtures/android-physical/build.mjs
```

The builder uses the private helper's pinned Gradle wrapper, Android Gradle plugin 8.12.0, and Material 1.13.0. It builds in a temporary directory with a 1 GB Gradle heap and no persistent daemon, then writes `fixture.apk` and its SHA-256 receipt under `artifacts/android-physical/build/`. It generates a disposable signing key and deletes it with the temporary build. A later build cannot update an installed fixture signed with an earlier key. The proof refuses an existing fixture installation and removes the fixture only if it installed it.

Package: `dev.contingency.physicalfixture`. Starting activity: `.MainActivity`. Starting condition: `text` named `Fresh fixture data`. `Store fixture data` persists a marker; a subsequent authorized clear must restore the fresh screen. The app requests notification permission on launch so preparation must establish its declared grant or denial before the activity starts.

Native password accessibility text is masked. The private-text helper must report `input_unverified` after attempted input into that field. A complete private proof also requires verified exact readback from the stock Material field and `input_unverified` from the filtered Material field. These are separate widget contracts; success on Material does not establish support for native password fields or every password widget.

Read the Android physical-device recipe in `features/workspace.md` before running the proof. Device selection, installations, fixture data clearing, and fixture permission changes require explicit authorization on a physical device. The proof does not wipe the phone or change its input method.

Each proof launch force-stops only the fixture package and starts a fresh activity window with a disposable `focus-token`. `FixtureActivity` logs that token only when its window has focus; the runner awaits that event and checks the focused window before proceeding. Tokens carry no private input. Ordered field removal and focus events keep refusal checks tied to completed mutations rather than launch acknowledgements or elapsed time. Every scoped logcat watcher is stopped and awaited before the next operation.
