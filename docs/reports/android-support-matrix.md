# Android Support Matrix

Issue #489 proves the Android Support Matrix for #457. Every cell below passed live on 2026-10-15 through the product entry points: Workspace for Teaching and verification, and the MCP server for Dry Runs and later Runs. Android is supported only within this matrix. Every capability outside it is a documented limit, which the product refuses or pauses on explicitly.

## Cells

Each cell ran [`android-support-matrix-proof.mjs`](../../.cursor/skills/verify-contingency/bin/android-support-matrix-proof.mjs) against the [login fixture](../../.cursor/skills/verify-contingency/fixtures/android-physical/README.md), built with minimum API 30. In each cell, the user taught one journey in Workspace: a public **Login name** fill, a `{{PASSWORD}}` private fill, **Sign in privately**, **Open account**, and **Android Back**. The Timeline recorded exactly one `fill`, one `variable`, two `activate`, and one `back` action, with no coordinate keys. An agent learned the Flow Skill and repeated every action in a fresh Dry Run. The user chose **Verify flow**, the Recording was purged, and a later Run also passed.

| Device | API | Release | Activate | Public fill | Private fill | Back | Teaching | Dry Run | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pixel_9 emulator | 36 | 16 | Pass | Pass | Pass | Pass | Pass | `working` | Verified, purged |
| Pixel_9_API_30 emulator | 30 | 11 | Pass | Pass | Pass | Pass | Pass | `working` | Verified, purged |
| Nothing Phone 3a (A059) | 36 | 16 | Pass | Pass | Pass | Pass | Pass | `working` | Verified, purged |

The [sanitized evidence](android-support-matrix-evidence.json) records each cell's device identity, Timeline action kinds, session outcomes, refusal messages, privacy scan, and cleanup. Retained ARIA snapshots and screenshots stayed under the skill's ignored `artifacts/` directory. No generated private value appeared in recordings, runtime diagnostics, MCP logs, logcat, or child-process arguments. Cleanup uninstalled only packages the proof installed and left ADB forwards, the input method, and runtime directories at their baseline.

Selection accepts API 30 through 36 and refuses every other level with a typed `api_unsupported` reason, before any device command. Only API 30 and 36 are proven; the levels between them are accepted without a cell of their own.

## Documented limits

Every cell produced each refusal or pause below on a live Run.

| Limit | Behavior | Evidence |
| --- | --- | --- |
| API levels below 30 | Refused at selection: `api_unsupported` in startup, `android_api_unsupported` in app discovery, and the setup sheet disables the device | API 29 start refused before Teaching |
| Multiple bound devices | One live session binds one device. A second session is refused while another is pending, running, or paused, on the same or another serial | Both refusals while the limits Run was live |
| Raw coordinates | The MCP schema has no coordinate action. A Workspace point resolves to a fresh semantic element or is refused | MCP `tap` rejected; a blank Workspace point showed **Nothing to activate there. No input was sent.** |
| System dialogs | A Run refuses the untaught control that opens the dialog. A dialog opened anyway pauses the Run on `ownership_unknown` | Camera permission dialog paused the Run; recovery took a fresh observation after the dialog closed |
| Secure windows | A secure window pauses the Run on `secure_window`, and a `working` claim is stored as `inconclusive` | `FLAG_SECURE` login window |
| Cross-app actions | A Run refuses the untaught control that leaves the app. Another app's window pauses the Run on `ownership_unknown` | Settings in the foreground paused the Run; recovery returned to the fixture |

Android 11 has no `pm set-permission-flags`. Permission decisions now require API 31 and are refused on API 30 with `permission_decisions_unsupported` before any device command. Preparation also fails when `pm` prints anything, so an unknown command can no longer pass as success.

## Product changes

- Android needs no opt-in. `CONTINGENCY_MCP_ANDROID_EXPERIMENTAL` is gone, and the native catalog lists `agent_device_workspace` and `agent_device_sessions_list` with `platform: "android"`. These replace the Android-specific names without aliases under [ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md). iOS calls return the typed `ios_support_matrix_unproven` refusal until its Support Matrix is proven. The catalog budget originally rose from 81 KB to 91 KB when Android left its opt-in.
- The Experimental badge, the experimental Summary field, and the **Android experimental** entry label are gone. The entry button reads **Android**.
- Back, a picked field, and a private-field binding compare only the Target App's own elements to detect a changed screen. In one earlier phone run, a Workspace Back during Teaching sent no input, and its refusal text was not captured. A service test shows that a status-bar change alone refused Back before this fix, which is the likely cause.
- Discovery reports each device's Android release. The setup sheet declares that release as the taught Android version instead of a fixed `16`.

## Proof details

- Workspace recovery is a user action. After each pause, the runner closed the dialog or app with Back from outside the runtime and clicked **Recover same emulator** or **Recover same device**.
- The raw-coordinate probe took Workspace control and returned it. The limits Run therefore records `takeoverOccurred`, and its secure-window outcome is `inconclusive`. It never claimed a pass.
- On the phone, the cross-app probe opened Settings without changing anything, and the camera permission prompt was dismissed as a denial for the disposable fixture. The fixture was uninstalled afterwards.

## Out of scope

This proof adds no devices or API levels beyond the matrix and builds no documented-limit capability. Necessary-system-dialog authority, cross-app permission, secure-window capture, observation-bound coordinates, and multiple-device Runs remain [ADR 0058](../adr/0058-android-is-the-next-platform-runtime.md) work.
