# Physical Android proof fixture

This disposable app (API 30 through 36) proves app-data preparation and ordinary fills without opening Settings on a daily-use phone. It requests `POST_NOTIFICATIONS` at launch and `CAMERA` only from the system-dialog probe. It has a native masked password field, an ordinary field, a persistent data marker, and reversible buttons for semantic-action and target-change checks. A replacement activity stays in the same package.

`MaterialPasswordActivity` uses stock Material Components 1.13.0 `TextInputLayout` and `TextInputEditText` with password input type. The screen remains masked. Material's own accessibility delegate exposes the actual editable text, so stock agent-device can read back the field. The fixture has no readback endpoint or accessibility override. The `filter` intent extra applies an Android `InputFilter` that replaces input with the same number of `x` characters; that fill must remain uncertain. An ordered, package-scoped `REMOVE_PASSWORD` broadcast removes the field and acknowledges completion with result code 1 for the mismatch refusal. This mutation exposes no field value.

Build with JDK 17 and Android SDK platform/build-tools 36:

```sh
JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=/path/to/android-sdk \
  nub .cursor/skills/verify-contingency/fixtures/android-physical/build.mjs
```

The builder uses its own pinned Gradle wrapper, Android Gradle plugin 8.12.0, and Material 1.13.0. It builds in a temporary directory with a 1 GB Gradle heap and no persistent daemon, then writes `fixture.apk` and its SHA-256 receipt under `artifacts/android-physical/build/`. It generates a disposable signing key and deletes it with the temporary build. A later build cannot update an installed fixture signed with an earlier key. The proof refuses an existing fixture installation and removes the fixture only if it installed it.

Package: `dev.contingency.physicalfixture`. Starting activity: `.MainActivity`. Starting condition: `text` named `Fresh fixture data`. `Store fixture data` persists a marker; a subsequent authorized clear must restore the fresh screen. The app requests notification permission on launch so preparation must establish its declared grant or denial before the activity starts.

Native password accessibility text is masked. A fill without exact readback is entered but unconfirmed. Readable matching text confirms a fill. Sign-in and the journey outcome decide the assessment.

Read the Android physical-device recipe in `features/workspace.md` before running the proof. Device selection, installations, fixture data clearing, and fixture permission changes require explicit authorization on a physical device. The proof does not wipe the phone or change its input method.

Each proof launch force-stops only the fixture package and starts a fresh activity window with a disposable `focus-token`. `FixtureActivity` logs that token only when its window has focus; the runner awaits that event and checks the focused window before proceeding. Tokens carry no private input. Ordered field removal and focus events keep refusal checks tied to completed mutations rather than launch acknowledgements or elapsed time. Every scoped logcat watcher is stopped and awaited before the next operation.

# Stream display fixture

`StreamActivity` adds public screen changes and a `FLAG_SECURE` toggle for the [Android live stream recipe](../../features/workspace.md#android-live-stream). It requests no permissions and does not change the private-input activities.

Build with `--permission-launcher` to write `artifacts/android-physical/build-permissions/fixture.apk` with `MainActivity` as its launcher. Use this variant to prove setup permission decisions against the activity that requests notifications at launch. The default build still launches `StreamActivity`.

## Login journey

Build with `--login-launcher` to launch `LoginActivity` under its Material theme. The APK is written to `artifacts/android-physical/build-login/fixture.apk`. It has a stock Material password field, **Sign in privately**, and the outcome **Signed in privately**. The password stays masked and is never logged, persisted, or reflected in outcome text. Any nonempty password completes this disposable fixture's login.

The default window has no `FLAG_SECURE`. **Show secure login window**, or the fixture-only launch extra `--ez secure true`, enables it for refusal proof. Restart the fixture without that extra to return to the ordinary login screen. Follow [Android Support Matrix](../../features/workspace.md#android-support-matrix) for device consent, Workspace Teaching, Variable supply, learning, verification, fill confirmation checks, and cleanup.

The login launcher also has a public **Login name** field. After sign-in it shows **Signed in as <name>** and **Open account**, which opens the same-package **Account details** screen so Back has an observable outcome. **Request camera permission** opens a system permission dialog, and **Open device settings** opens another app. Both exist only to probe documented limits in the [Android Support Matrix](../../features/workspace.md#android-support-matrix) recipe.
