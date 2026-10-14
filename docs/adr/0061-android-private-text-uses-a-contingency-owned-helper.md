---
status: accepted
---

# Android private text uses a Contingency-owned helper

For [issue 478](https://github.com/akshat-OwO/contingency/issues/478), private Variables on Android reach the device through a Contingency-owned instrumentation helper, beside stock agent-device. The helper receives the value over an authenticated, ADB-forwarded loopback socket, enters it with `AccessibilityNodeInfo.ACTION_SET_TEXT` on the bound field, and verifies the result internally. Stock agent-device keeps every other action. This amends [ADR 0060](./0060-use-stock-agent-device-for-an-experimental-android-runtime.md), which deferred private Variables, and serves the private login that [ADR 0058](./0058-android-is-the-next-platform-runtime.md) requires.

The [driver feasibility prototype](../reports/android-driver-feasibility.md) proved this path on an emulator: the value never appeared in ADB arguments or diagnostics, and readback matched. Stock agent-device sends text through an IME broadcast whose base64 payload is an ADB argument, so it cannot carry secrets.

## Considered options

- **Upstream first.** A supported local provider configuration in agent-device would reuse its internal `AndroidAdbProvider.text` callback. Upstream deliberately removed daemon embedding in its PR 481, so acceptance is uncertain and would gate private login on another project's schedule.
- **A helper fork.** A fork would take on build, signing, update, and compatibility work for the whole helper, not only text entry.

## Consequences

Contingency builds, signs, and installs one helper APK, with the user's consent, as it already does for agent-device's helper. Cleanup removes only state that Contingency owns. Contingency refuses secrets until the helper passes a sentinel test: a generated value must not appear in ADB arguments, logcat, or diagnostics on the emulator and on the physical device. Android allows only one UiAutomation connection at a time. [Issue 490](https://github.com/akshat-OwO/contingency/issues/490) settled that the helpers take turns: when a Run requires private input, agent-device captures in one-shot mode, which releases the connection between commands, and the helper holds it only for one fill. Agent-device keeps its session across the fill. The [private text report](../reports/android-private-text.md) records the evidence. The emulator Settings field passed the sentinel test. The expanded [physical-device fixture](../reports/android-physical-device.md#stock-material-private-readback-revision) proves exact internal readback and sentinel absence on a stock Material password widget. Its native masked field and same-length filtered Material field return `input_unverified`. Readback support depends on the widget's accessibility implementation; these proofs do not establish support for every password field.
