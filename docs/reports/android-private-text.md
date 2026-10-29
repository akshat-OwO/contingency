# Android private text beside agent-device

> Superseded by [ADR 0067](../adr/0067-runtimes-trade-privacy-and-app-boundaries-for-reach.md): Variables are no longer private. [issue 564](https://github.com/akshat-OwO/contingency/issues/564) removes the helper this report describes.

For [issue 490](https://github.com/akshat-OwO/contingency/issues/490), the experimental Android runtime enters a private Variable through a Contingency-owned helper while stock agent-device keeps its session. The helper and agent-device take turns: agent-device runs its capture helper as one short instrumentation per command, and the private text helper holds the device only for one fill. The emulator Settings proof passed. The fixture proof now covers stock Material password widgets and preserves native masked-field uncertainty; see [Physical widget proof](#physical-widget-proof). This follows [ADR 0061](../adr/0061-android-private-text-uses-a-contingency-owned-helper.md) and does not wire private Variables into Workspace or Runs.

## Coexistence: take turns, not share

Android allows one UiAutomation connection at a time. Two experiments on the Pixel_9 API 36 emulator settled how the helpers coexist.

| agent-device capture mode | Result when the private text helper starts |
| --- | --- |
| Persistent session (default) | The snapshot helper process stays alive after a snapshot. The private text helper crashes in `UiAutomation.connectWithTimeout`. |
| One-shot (`AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION=0`) | No snapshot helper process remains between commands. The private text helper connects. An agent-device snapshot taken while the helper runs fails; the next snapshot in the same agent-device session succeeds after the helper exits. |

Sharing would need a change to agent-device's helper or a fork. Both are out of scope. The runtime therefore launches its private agent-device daemon in one-shot mode when the Run requires `private-input`, and only then. The pinned agent-device 0.21.25 daemon reads this variable. The runtime still removes every other `AGENT_DEVICE_*` variable.

One-shot capture has no measurable cost at the runtime level. Four observations took 1,905–2,104 ms with the persistent session, and four took 1,976–2,226 ms in one-shot mode. Screenshot transfer and ownership checks dominate both.

The runtime serializes observation, actions, recovery, and private fills on one lock, so the turns never overlap. Before it starts the private text helper, the host refuses with `helper_owned` if either helper process is already running. If agent-device's helper still connects first, the private text helper reports `automation_busy` and exits. The host maps that to `helper_owned` too, and no value has been sent.

## The private text helper

The helper is `dev.contingency.privatetext`, a 14 KB instrumentation APK with no dependencies beyond the Android framework. Its source and build are in [packages/cli/android/private-text-helper](../../packages/cli/android/private-text-helper/README.md). The runtime pins the committed APK's SHA-256 and signing certificate digest in `androidPrivateTextRelease`. Contingency signs it with its own release key, not a debug key.

The helper requests UiAutomation with `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`, so the user's accessibility services keep running during a fill. It never changes the input method. It contains no logging calls.

One fill is one helper lifetime:

1. The host starts `am instrument` with an ephemeral 48-character token and the target package. These are the only instrumentation arguments.
2. The helper binds an ephemeral loopback port and reports it as instrumentation status. The host forwards a host port to it with `adb forward tcp:0`.
3. **Bind.** The host sends the observed field: package, resource ID, class, bounds, and password flag. The helper requires the active window to belong to the target app. It requires exactly one enabled, visible, editable node matching all five properties. It records that window's accessibility window ID. A failure returns `field_mismatch` or `foreground_changed`, with `inputSent: false`.
4. **Window check.** The host checks again that the focused window is the one recorded at capture. The capture binds fields only if the same window was focused before and after the snapshot. The host also checks before it starts the helper.
5. **Fill.** Only now does the host resolve the Variable and send the value over the socket. The helper requires the active window and the re-resolved node to have the window ID recorded at bind; otherwise it returns `window_changed` without input. It sets the text with `ACTION_SET_TEXT`, refreshes the node, and requires the text to equal the value exactly. It reports `verified`, or an error with `inputSent: true`.
6. The helper exits. Finalizers close the socket, remove the forward, force-stop the helper package, and confirm no helper process remains. Each step runs even if an earlier one fails. Any failure returns `cleanup_failed`, even after a verified fill, and the backend keeps its device lock for inspection.

In the tested API 36 Settings password field, UiAutomation reads the real text, so readback is exact rather than a length comparison. A device that masks password text to UiAutomation returns `input_unverified`. That result is uncertain, not verified.

## Runtime contract

`AndroidPlatformRuntime.enterPrivate(observationId, { target, variable, value })` returns `{ outcome: "verified", variable }` or a typed `PlatformRuntimeError`. The value is an `Effect` of `Redacted<string>`, resolved only after bind. Results and errors never contain it.

| Condition | Code | Value resolved | Input |
| --- | --- | --- | --- |
| Observation already consumed or replaced | `observation_stale` | No | No |
| Runtime started without `private-input` | `capability_missing` | No | No |
| Target absent, covered, foreign, not editable, or not a password field | `target_unsupported` | No | No |
| Focused window differs from the observation, before or after bind | `target_changed` | No | No |
| Helper cannot find exactly the bound field | `target_changed` (`field_mismatch`) | No | No |
| Active window changed between bind and fill | `target_changed` (`window_changed`) | Yes | No |
| Foreground left the target app | `ownership_unknown` | No | No |
| Either helper already running | `helper_owned` | No | No |
| Failure after the fill request was sent | `private_input_uncertain` | Yes | Possibly |
| Forward removal or helper stop failed | `cleanup_failed` | Yes | Possibly |

Only password fields are accepted. Observations name a password field `Private field`, and its screenshot shows a mask. Any other field would show the value in the next observation's node names and screenshot.

Every failure pauses the runtime and invalidates the observation, as other dispatch failures do. The runtime never retries a fill. After `private_input_uncertain`, the caller must observe before continuing. A verified fill also leaves the outcome `uncertain` until a fresh observation.

Private input needs a second installation grant. `privateTextGrant` names the serial, the exact helper SHA-256, and `install` or `replace`. It is separate from agent-device's helper grant. Runtime cleanup never uninstalls either helper.

Android Runs still refuse `private-input` with `capability_missing`, and Workspace still refuses private requirements. Wiring private Variables into them belongs to the private login child of issue 457.

## Emulator proof

On 2026-10-14, `packages/cli/scripts/verify-android-private-text.ts` ran on the Pixel_9 API 36 emulator at `emulator-5554`. The emulator was started for the proof. The target was the unmodified Settings app: the Wi-Fi **Add network** dialog with WPA/WPA2-Personal security has a real password field, and cancelling it saves nothing. The [sanitized receipt](android-private-text-evidence.json) records every outcome below.

- **Installation consent.** Startup without `privateTextGrant` failed with `installation_denied`. The proof then installed the helper under an exact grant and uninstalled it at the end.
- **Sentinel fill.** A generated 27-character value entered the password field and returned `verified`.
- **Process lists.** During the fill, the runner took 8 device `ps -A -o ARGS` samples and 8 host `ps -axo args` samples. Two device samples showed the helper running. No sample contained the value.
- **Logs and diagnostics.** Device logcat from just before the fill did not contain the value. Neither did any of the 15 files in the runtime's private agent-device directory, read after the fill and again before close. Neither did any full observation, including node names, or the receipt.
- **Session kept.** After the fill, the runtime observed and activated **Advanced options** through agent-device. All observations carried the same agent-device session ID, with no recovery between them.
- **Refusals.** A consumed observation returned `observation_stale`. After the proof changed the security type to None outside Contingency, the password field disappeared and the fill returned `target_changed`. A non-password editable field (Network name) returned `target_unsupported`. Opening Device info over the dialog before the fill returned `target_changed` from the host's window check. After moving to the Home screen, the fill returned `ownership_unknown`. None of these five resolved the value.
- **Window replaced after bind.** The proof's Variable opened Device info over the dialog while it resolved, after the helper had bound the field. The helper returned `window_changed` with no input. After returning to the dialog, a UI Automator dump showed that this second generated value had not been entered.
- **Cleanup.** After close, ADB forwards for the serial, the default and enabled input methods, and the saved Wi-Fi networks all matched their values before the proof. No helper process remained.

Traces and the Teaching Timeline were not checked because this path produces neither. Android Teaching capture is unsupported, and private Variables are not wired into Workspace.

The spinner's dropdown is a `PopupWindow`. The runtime's ownership check refuses it as `ownership_unknown`, as it did before this change. The proof therefore selects the security type with UI Automator taps outside the runtime, between helper turns.

Validation passed `nub exec turbo run quality`, the CLI type check, and the Android runtime, Run, Workspace, session lifecycle, and private text service tests. The private text tests use a scripted helper for the protocol and a real loopback socket for framing.

## Physical widget proof

The disposable fixture now includes stock Material Components 1.13.0 `TextInputLayout` and `TextInputEditText`, with password input type. Material's accessibility delegate exposes the editable text to UiAutomation while the screen stays masked. The unchanged pinned helper reads that field after `ACTION_SET_TEXT` and compares its actual content internally. The fixture supplies no readback endpoint or accessibility override.

The native `EditText` remains a negative control. A second Material field uses an Android `InputFilter` that replaces every input character with `x`. The result has the same length as the supplied sentinel, but different content. This control must return `input_unverified`; it rules out treating input acknowledgement or length equality as verified readback.

The maintained [physical-device recipe](../../.cursor/skills/verify-contingency/features/workspace.md#android-physical-device) runs each widget in a scoped runtime. It requires fresh observations, semantic continuation in the same agent-device session, stale and ordinary-field refusals, removed-field refusal, and window replacement before and after bind. Native and filtered uncertainty require explicit recovery. Verified Material input continues without recovery.

The proof's fixture mutations now acknowledge their completion. Window transitions force-stop only the fixture, start a fresh window, await its focus callback, and confirm the focused owner-user-0 window. Ordered removal broadcasts detach the edit control from its actual parent and acknowledge detachment. Earlier attempts exposed incomplete fixture transitions and removal from Material's outer layout instead of its internal container. Those failed receipts are retained. These fixture fixes do not establish the cause of the original #484 semantic failure.

On 2026-10-14, the Nothing Phone 3a and Pixel_9 API 36 emulator completed the full fixture proof. Material exact readback, native and filtered uncertainty, same-session semantic continuation, all targeting refusals, sentinel audits, and cleanup passed. The [sanitized widget receipt](android-private-text-widget-evidence.json) records the final revision. Material used 20 host and device process samples, including six sightings of the private helper; no sample contained the sentinel. Each widget audited eight host diagnostic files. Screenshots stayed masked and every password node was named `Private field`.

Traces and Teaching Timeline were not produced because this runtime entry point does not create a Teaching Recording or wire private Variables into Workspace or Runs. Phone Settings, profile changes, wireless ADB, and disconnect were not exercised in this revision.

Validation passed 35 focused Android private-text, runtime, and Run service tests, the CLI type check, and a dedicated type check of both proof scripts. The restore verifier also refused a wrong password with sanitized diagnostics. The fixture was rebuilt from its final Java sources; no production helper or runtime code changed.

## Signing-key custody

The maintainer imported the existing release key into a private Bitwarden Secure Note and supplied its restored contents on 2026-10-14. The [restore verifier](../../packages/cli/android/private-text-helper/README.md#signing-key-custody-and-restore) signed a disposable APK with that restored private key. Its certificate matched the pinned release signer. Temporary restored files and the plaintext import were removed. Account recovery remains the maintainer's responsibility.

## Remaining work

- **Widget support.** Native password fields that expose transformed accessibility text remain uncertain. Verified readback applies only to the tested stock Material widget and emulator Settings field. System-wide password-widget support is not established.
- **System dialogs and popups.** Fills inside a `PopupWindow` or a system dialog are refused, like other actions.
