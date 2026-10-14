# Physical Android proof fixture

This disposable API 36 app proves app-data preparation and private text without opening Settings on a daily-use phone. Its only requested runtime permission is `POST_NOTIFICATIONS`. It has a masked password field, an ordinary field, a persistent data marker, and reversible buttons for semantic-action and target-change checks. A second activity provides a replacement window in the same package.

Build with JDK 17 and Android SDK platform/build-tools 36:

```sh
JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=/path/to/android-sdk \
  nub .cursor/skills/verify-contingency/fixtures/android-physical/build.mjs
```

The builder writes `fixture.apk` and its SHA-256 receipt under `artifacts/android-physical/build/`. It generates a disposable signing key in a temporary directory and deletes it after building. A later build cannot update an installed fixture signed with an earlier key. The proof refuses an existing fixture installation and removes the fixture only if it installed it.

Package: `dev.contingency.physicalfixture`. Starting activity: `.MainActivity`. Starting condition: `text` named `Fresh fixture data`. `Store fixture data` persists a marker; a subsequent authorized clear must restore the fresh screen. The app requests notification permission on launch so preparation must establish its declared grant or denial before the activity starts.

Native password accessibility text is masked. The private-text helper must report `input_unverified` after attempted input; this fixture cannot prove a verified private fill. A successful preparation receipt must keep that limitation explicit.

Read the Android physical-device recipe in `features/workspace.md` before running the proof. Device selection, installations, fixture data clearing, and fixture permission changes require explicit authorization on a physical device. The proof does not wipe the phone or change its input method.
