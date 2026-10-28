---
status: accepted
---

# Runtimes trade privacy and app boundaries for reach

Contingency is a sanity monitor, and organizations run it against test accounts. Its guarantees for private Variables and the native app boundary cost more than they protected. On iOS, stock agent-device failed the [ADR 0061](./0061-android-private-text-uses-a-contingency-owned-helper.md) sentinel test, and exact readback of a secure field needed code injected into the Target App. Because the Support Matrix login journey includes a private fill, that one capability kept the whole runtime unlisted. On Android, every permission prompt or system dialog paused a Run on `ownership_unknown`. Contingency drops both guarantees and supports native runtimes on emulators and simulators only.

## Rules

- **Variables are runtime inputs, not secrets.** On every Platform Runtime, including the browser, a Variable's value is plain text wherever it appears: Teaching Timelines, MCP responses, Run Summaries, traces, and logs. A saved Flow Skill names the Variable, such as `{{PASSWORD}}`, and never stores its value, so one skill works across test accounts. Contingency reads an existing `secret: true` declaration, ignores it, and never writes it again.
- **Native agents use the whole emulator OS.** The Target App identifies what a journey tests. It no longer limits where the agent may act. The agent may answer system dialogs, open Settings, and use other apps. Runs no longer pause on `ownership_unknown`, and cross-app authorization is gone.
- **Untaught controls are allowed, and Confirmation still applies.** A native Run may activate controls that Teaching never recorded. An action the agent marks irreversible or high-impact pauses for Confirmation, as it does in the browser. Native runtimes gain the Confirmation they lacked.
- **The browser keeps Domain Scope.** The browser is easier to monitor than a device, so its host boundary stays.
- **Only emulators and simulators are supported.** Selecting a physical device is refused with `physical_device_unsupported` before any device command. Physical-device code, proofs, and recovery paths are removed.
- **A fill is confirmed when the field can be read.** Otherwise the fill is recorded as entered but unconfirmed, and the journey's outcome decides the assessment. A wrong password still fails at sign-in.
- **The Support Matrix gate stays.** A runtime remains unlisted until every cell of its matrix passes. A private fill is now an ordinary fill.

## Considered options

- **Keep privacy, but limit it to agent-readable evidence.** This matches the browser's original stance in [ADR 0010](./0010-run-video-is-unredacted.md): the value never reaches the agent, and local logs are purged at Cleanup. It still requires scrubbing every response and log a third-party driver writes. It also protects nothing that a test account needs protected.
- **Keep the app boundary and authorize system dialogs.** [ADR 0058](./0058-android-is-the-next-platform-runtime.md) planned a necessary-system-dialog authority. Classifying dialog ownership per platform is the same open-ended work that kept dialogs as a documented limit. An emulator is disposable, so the boundary protects little.
- **Keep physical devices with the app boundary.** That would split one runtime into two rule sets. A personal phone also holds real messages and accounts, which full OS use must not reach.

## Consequences

- [ADR 0061](./0061-android-private-text-uses-a-contingency-owned-helper.md) is superseded. The Contingency-owned helper APK, its install consent, the sentinel test, and the turn-taking with agent-device for the device's single UI Automator connection are removed. Stock agent-device types every value.
- [ADR 0058](./0058-android-is-the-next-platform-runtime.md) is amended. Its execution boundary, cross-app authorization, ambiguous-ownership pauses, secret-input evidence rules, and physical-device preparation no longer apply.
- [ADR 0060](./0060-use-stock-agent-device-for-an-experimental-android-runtime.md) is amended. Its deferred private Variables, weaker dispatch guarantees, and physical-device scope no longer apply.
- [ADR 0010](./0010-run-video-is-unredacted.md) is amended: `run.json`, traces, and other Run evidence no longer redact Variable values.
- Raw media is still local evidence, and Cleanup still purges it after verification. Contingency's own Settings, such as a System One credential, still come only from the process environment. They configure Contingency and are not journey Variables.
- The [Android Support Matrix](../reports/android-support-matrix.md) loses its physical-device row and its system-dialog and cross-app limits. A secure window still pauses a Run, because the screen cannot be captured. Its proof must show the agent handling a system dialog and a Confirmation pause.
