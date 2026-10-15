# User-owned Android devices

Issue [484](https://github.com/akshat-OwO/contingency/issues/484) extends the experimental runtime to an explicitly selected local API 36 physical device. Emulator selections retain their AVD identity and existing restart recipe. Physical selections record the serial, model, API level, and build fingerprint. Shared read-only identity validation runs before preparation, execution, and recovery. It never invokes emulator commands on a physical device or selects a replacement device.

## Preparation and consent

Only owner user 0 is supported. A secondary active user or focused work-profile window is refused. Each physical Teaching session and Run requests app-data consent naming owner user 0, its serial, and Target App. Refusal blocks preparation. Consent is scoped to the current Run; a later Run asks again. Helper installation and app installation retain their separate grants. The backend checks clear-data consent before installation or app mutation, including direct backend preparation.

Active user validation runs before preparation, execution, recovery, and immediately before each preparation mutation or helper installation. Package installation, data clearing, permission changes, activity launch, and private instrumentation explicitly target user 0. Permission readback uses only the `User 0:` package section. A profile change observed before dispatch blocks the operation; a change after the check cannot redirect the explicitly scoped command to another profile.

Physical preparation clears only the Target App's data, applies declared runtime-permission decisions, and launches the declared activity. It then checks the required starting conditions against a fresh observation. Preparation failures block input. Recovery does not clear data or reapply permissions.

Permission decisions belong to the taught environment and are retained with the session and learned requirements. Selected differences require Run Environment Permission without rewriting the taught environment. Preparation applies each grant or denial and fixes its app-scoped permission choice so an initial request cannot override the declaration. Execution and recovery revalidate the actual permission state; drift pauses the session. Unexpected system dialogs remain outside the experimental runtime's supported ownership contract and pause input.

Workspace accepts a physical-device selection and renders a distinct clear-data request. It supports notification permission and additional `grant android.permission.NAME` or `revoke android.permission.NAME` declarations. Duplicate or malformed declarations are refused.

## Physical private text and widget limits

PR [491](https://github.com/akshat-OwO/contingency/pull/491) proved exact private readback in the emulator's Settings password field. The disposable native fixture on the Nothing Phone 3a returns masked accessibility text. The helper reports `input_unverified`; the runtime returns `private_input_uncertain`, pauses, and does not retry. The host now retains that safe error reason without returning helper text or a private value.

This behavior follows Android 16's [TextView accessibility implementation](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/core/java/android/widget/TextView.java), which exposes the transformed display text. Exact readback depends on the Target App's field implementation. The Settings emulator proof does not establish readback support for every password field.

The maintainer authorized fixture installation, fixture-data clearing, app-scoped notification decisions, and pinned helper installation on the phone. They declined a separate Settings-dialog proof. No phone Settings proof is claimed. The expanded fixture now proves exact physical readback from a stock Material password widget, as recorded in [the private-text report](android-private-text.md#physical-widget-proof). Native password readback remains uncertain. Private Variables remain unavailable in Workspace and Runs. The existing signing key has a Bitwarden backup whose restored private key passed the signer check.

## Verification

The maintained recipe is [Android physical device](../../.cursor/skills/verify-contingency/features/workspace.md#android-physical-device). The fixture is `dev.contingency.physicalfixture`, built from the committed Java sources. It has a persistent marker, a notification request, native password and ordinary fields, a semantic-action button, and a replacement activity. The proof refuses to replace or clear an existing fixture installation.

Live receipts and Workspace evidence are recorded under the ignored `artifacts/android-physical/` directory. The [sanitized evidence receipt](android-physical-device-evidence.json) records the final results. Cleanup compares installed-package digests, the selected serial's forwards, and both IME settings, and checks for a surviving private helper process. It removes only proof-installed packages and scoped runtime resources.

On 2026-10-14, the Nothing Phone 3a USB proof passed consent refusal, fresh starting conditions, persistent-data clearing, notification grant and denial, disconnect pause, refusal of recovery while disconnected, and recovery on the same serial with a fresh observation. The emulator remained available throughout the phone disconnect; it was never selected as a replacement.

The original later native private-input stage returned `input_unverified`. Its post-fill semantic check failed after recovery, so that attempt stopped before completing the phone sentinel audit. The receipt explicitly separates the earlier passing preparation/disconnect assertions from this incomplete private-input proof. Both failures and cancellation cleaned up the proof-installed packages and scoped resources. No verified physical private fill is claimed.

The Pixel_9 API 36 native fixture proof passed, including typed uncertainty, stale/ordinary/window refusals, semantic continuation after recovery, and cleanup. The original #491 Settings recipe also passed again on the emulator: exact readback was verified, the agent-device session survived, all refusal checks passed, the sentinel was absent from audited diagnostics and process arguments, and cleanup preserved the IME and saved networks.

The production Workspace proof on the phone passed explicit serial/app consent, refusal, a fresh consent request in a new session, allowed preparation, mirrored Teaching, and Timeline readback. The claimed recording retains `clear-app-data` and the recorded notification denial; its Timeline contains exactly one `Activate button Store fixture data` action with before-and-after evidence. Screenshots and ARIA snapshots are under `artifacts/android-physical/ui/`.

Validation passed 49 focused CLI service tests, five Workspace parser tests, protocol/CLI/web type checks, the dedicated proof-script type check, `nub exec turbo run quality`, and a forced production CLI/Workspace build. No new integration test files were added. Wireless ADB was not exercised. The happy Workspace path was proved before the final connection-error normalization; the affected unplug/recovery path was rerun afterward.

## Profile-scoping review revision

The P1 review reproduced a mismatch between `pm clear` defaulting to user 0 and `am start` defaulting to the current user. The runtime now refuses non-owner or unknown active users before mutation, checks again before each mutation, explicitly targets user 0, and reads permission grants only from that user's package section. Focused windows from another profile are refused. Workspace consent names owner user 0.

Two new regressions failed before the fix: active user 10 with the app installed under both users still reached clearing, and permission readback selected user 10's conflicting grant. The final regression suite also covers a profile switch after consent, unknown user output, and absent owner permission records. All 53 focused CLI service tests passed, along with type checks, quality, and the production build.

The final fixture rerun passed on both Pixel_9 and the Nothing Phone 3a under owner user 0. Phone preparation proved consent refusal, persistent-data clearing, notification grant and denial, and fresh observations. This phone attempt also passed semantic continuation after uncertain private input, all refusal checks, and sentinel audits. It still returned `input_unverified`, so exact physical private readback remains unproved and #490 stays open. This successful attempt does not establish the cause of the original post-fill semantic failure.

Both reruns preserved package, IME, and forward baselines and left no private helper process. Receipts are under `profile-fix-phone/` and `profile-fix-emulator/`. The production Workspace consent explicitly named owner user 0, the fixture package, and serial; refusal blocked preparation. Its screenshot and ARIA readback are under `profile-fix-ui/`. The session and isolated UI instance were closed and the proof-installed fixture removed. No secondary users were created or switched on the phone; those refusal paths use deterministic ADB simulations. USB unplug was not repeated for this revision. The original live disconnect proof remains recorded separately.

## Stock Material private-readback revision

The #490 fixture revision adds stock Material Components 1.13.0 password widgets without a custom accessibility delegate or private readback API. The Nothing Phone 3a completed the expanded fixture proof on 2026-10-14. Material returned `verified` after exact internal readback. Native masking and a same-length filtered Material value returned `private_input_uncertain`, paused, and required recovery without retry. All three controls continued semantic actions in the same agent-device session. Stale observations, ordinary fields, removed fields, and before/after-bind window changes were refused.

Sentinel audits passed for device and host process arguments, logcat, observations, and host diagnostics. Screenshots remained masked and password nodes were named `Private field`. Cleanup preserved package, IME, and forward baselines and left no private helper process. The owned Device panel stream and its forward were stopped separately after runtime cleanup. The daily phone remained connected and running. This revision repeated no disconnect or Workspace path and made no phone Settings or profile changes. The earlier live proofs remain recorded above.

The [widget evidence receipt](android-private-text-widget-evidence.json) records this revision independently of the original failed semantic attempt and the profile-scoping rerun. The failed fixture-removal and focus attempts are retained under ignored `artifacts/android-private-text-490/`; they exposed proof synchronization and parent-container errors. They do not establish the cause of the original semantic failure.
