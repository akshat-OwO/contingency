# User-owned Android devices

Issue [484](https://github.com/akshat-OwO/contingency/issues/484) extends the experimental runtime to an explicitly selected local API 36 physical device. Emulator selections retain their AVD identity and existing restart recipe. Physical selections record the serial, model, API level, and build fingerprint. Shared read-only identity validation runs before preparation, execution, and recovery. It never invokes emulator commands on a physical device or selects a replacement device.

## Preparation and consent

Each physical Teaching session and Run requests app-data consent naming its serial and Target App. Refusal blocks preparation. Consent is scoped to the current Run; a later Run asks again. Helper installation and app installation retain their separate grants. The backend checks clear-data consent before installation or app mutation, including direct backend preparation.

Physical preparation clears only the Target App's data, applies declared runtime-permission decisions, and launches the declared activity. It then checks the required starting conditions against a fresh observation. Preparation failures block input. Recovery does not clear data or reapply permissions.

Permission decisions belong to the taught environment and are retained with the session and learned requirements. Selected differences require Run Environment Permission without rewriting the taught environment. Preparation applies each grant or denial and fixes its app-scoped permission choice so an initial request cannot override the declaration. Execution and recovery revalidate the actual permission state; drift pauses the session. Unexpected system dialogs remain outside the experimental runtime's supported ownership contract and pause input.

Workspace accepts a physical-device selection and renders a distinct clear-data request. It supports notification permission and additional `grant android.permission.NAME` or `revoke android.permission.NAME` declarations. Duplicate or malformed declarations are refused.

## Physical private text limitation

PR [491](https://github.com/akshat-OwO/contingency/pull/491) proved exact private readback in the emulator's Settings password field. The disposable native fixture on the Nothing Phone 3a returns masked accessibility text. The helper reports `input_unverified`; the runtime returns `private_input_uncertain`, pauses, and does not retry. The host now retains that safe error reason without returning helper text or a private value.

This behavior follows Android 16's [TextView accessibility implementation](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/core/java/android/widget/TextView.java), which exposes the transformed display text. Exact readback depends on the Target App's field implementation. The Settings emulator proof does not establish readback support for every password field.

The maintainer authorized fixture installation, fixture-data clearing, app-scoped notification decisions, and pinned helper installation on the phone. They declined a separate Settings-dialog proof. No phone Settings proof is claimed. Issue [490](https://github.com/akshat-OwO/contingency/issues/490) remains open because a verified physical fill and exact helper readback are unproved within the authorized fixture. Private Variables remain unavailable in Workspace and Runs. Release-signing-key custody is unchanged and remains open.

## Verification

The maintained recipe is [Android physical device](../../.cursor/skills/verify-contingency/features/workspace.md#android-physical-device). The fixture is `dev.contingency.physicalfixture`, built from the committed Java sources. It has a persistent marker, a notification request, native password and ordinary fields, a semantic-action button, and a replacement activity. The proof refuses to replace or clear an existing fixture installation.

Live receipts and Workspace evidence are recorded under the ignored `artifacts/android-physical/` directory. The [sanitized evidence receipt](android-physical-device-evidence.json) records the final results. Cleanup compares installed-package digests, the selected serial's forwards, and both IME settings, and checks for a surviving private helper process. It removes only proof-installed packages and scoped runtime resources.

On 2026-10-14, the Nothing Phone 3a USB proof passed consent refusal, fresh starting conditions, persistent-data clearing, notification grant and denial, disconnect pause, refusal of recovery while disconnected, and recovery on the same serial with a fresh observation. The emulator remained available throughout the phone disconnect; it was never selected as a replacement.

The later native private-input stage returned `input_unverified`. Its post-fill semantic check failed after recovery, so that attempt stopped before completing the phone sentinel audit. The receipt explicitly separates the earlier passing preparation/disconnect assertions from this incomplete private-input proof. Both failures and cancellation cleaned up the proof-installed packages and scoped resources. No verified physical private fill is claimed.

The Pixel_9 API 36 native fixture proof passed, including typed uncertainty, stale/ordinary/window refusals, semantic continuation after recovery, and cleanup. The original #491 Settings recipe also passed again on the emulator: exact readback was verified, the agent-device session survived, all refusal checks passed, the sentinel was absent from audited diagnostics and process arguments, and cleanup preserved the IME and saved networks.

The production Workspace proof on the phone passed explicit serial/app consent, refusal, a fresh consent request in a new session, allowed preparation, mirrored Teaching, and Timeline readback. The claimed recording retains `clear-app-data` and the recorded notification denial; its Timeline contains exactly one `Activate button Store fixture data` action with before-and-after evidence. Screenshots and ARIA snapshots are under `artifacts/android-physical/ui/`.

Validation passed 49 focused CLI service tests, five Workspace parser tests, protocol/CLI/web type checks, the dedicated proof-script type check, `nub exec turbo run quality`, and a forced production CLI/Workspace build. No new integration test files were added. Wireless ADB was not exercised. The happy Workspace path was proved before the final connection-error normalization; the affected unplug/recovery path was rerun afterward.
