---
status: accepted
---

# Android is the next platform runtime

Contingency's current browser runtime limits the journeys users can teach and verify. Extend Contingency to Android through a composable Effect service, with room for a future iOS implementation. The first Android version must support one complete journey through Teaching, Flow Skill creation, Dry Run, and user verification.

Build the internal service contract around the needs of web and Android rather than committing to a public runtime plugin API. This supersedes the browser-only runtime boundary in [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md); the existing browser implementation remains supported.

ADB connects to emulators and physical devices. The user always selects the device, even when only one is available. The session remains bound to that device. A disconnect pauses the session rather than selecting another device.

Android Teaching initially uses the mirrored screen in Workspace. Contingency records the input it forwards together with before-and-after UI observations. Direct interaction on the device is outside the first version's Teaching capture contract.

A Dry Run must establish its declared starting state. Emulators use a restorable baseline. Physical devices require an explicit setup procedure or an authorized reset. If the required state cannot be established, the Run is blocked rather than treating existing device state as fresh.

The first Android execution boundary covers one declared Target App and necessary system dialogs. Leaving that boundary pauses for authorization. The Target App remains authorized when a journey leaves it and returns.

The first version attaches to user-prepared environments rather than provisioning devices. Contingency validates the selected device and app, restores a declared emulator baseline or executes an authorized physical-device setup procedure, and checks the required starting conditions.

Web and Android use separate Flow Skills. Each skill records its platform and environment requirements. Verification on one platform does not verify a journey on another.

The internal Effect service shares lifecycle, observation, and action contracts while exposing explicit platform capabilities. Platform-specific operations remain typed extensions. Missing required capabilities block startup rather than silently doing nothing.

The taught Android environment is a reference for later Runs. Preflight shows all recorded environment differences and requires Run Environment Permission for changes to Android version, app build, or app identity. Explicit device selection authorizes the chosen hardware. Permission applies only to the current Run, does not rewrite the taught environment or verification history, and cannot waive required capabilities or starting-state checks. Permission for a changed app identity also authorizes that app as the Run's Target App.

Contingency uses a separately installed, explicitly authorized UI Automator helper, communicating through ADB. The target app remains unmodified. Contingency owns the helper protocol and lifecycle through its Effect service.

Actions use semantic targets where available. Screenshot-based coordinate actions are an explicit fallback, bound to the observation they came from. Stale observations are rejected, and visual evidence is recorded. A Run whose outcome cannot be observed remains inconclusive.

Emulator preparation restores a baseline compatible with the selected Android system image and emulator configuration, installs or updates to the authorized app build, executes declared setup, and verifies required starting conditions. Environment permission cannot make an incompatible snapshot restorable. If preparation cannot establish those conditions, the Run is blocked. Physical devices use the declared setup or authorized reset procedure without assuming snapshot support.

Cross-app authorization names an additional app and lasts for the remainder of the current Run. The original Target App remains authorized. App-scope authorization does not replace Confirmation for irreversible actions.

A React Native fixture proves the first complete journey: log in with a secret Variable, add an item to a cart, and complete a mock checkout. Teach through Workspace, learn an Android Flow Skill, verify it through a Dry Run, and run it against a changed build. A deliberately broken build must demonstrate detection of a failed outcome as well as successful UI operation. React Native keeps the fixture easier to maintain.

Authorization is checked before known app launches. After an unexpected transition, Contingency pauses further input until the new app is authorized. Ambiguous screen ownership also pauses input. The boundary governs Contingency's actions; it cannot guarantee prevention of every transition initiated by an unmodified app.

Lost capture integrity ends Teaching as incomplete. Retain the evidence for inspection, but require a new complete recording before learning a verifiable skill. During a Run, capture or driver failures pause execution and invalidate outstanding observations. Unresolved evidence gaps prevent a passing Dry Run. Initial Takeover uses Workspace. Direct-device interaction is unsupported, and Contingency does not claim to detect or reconstruct every physical touch.

Android inherits the existing Teaching evidence privacy and Cleanup policy. Every retained capture source starts at Start recording and ends at Stop. Secret inputs become Variable references in agent-readable evidence. Raw media remains sensitive local evidence, may contain other apps or secrets, and is purged after verification. No pixel-level redaction guarantee is made. Respect secure windows; unavailable required outcome evidence makes the assessment inconclusive.

The user accepted this design after the design interview. An experimental Android runtime with a narrower capability set has shipped under [ADR 0060](./0060-use-stock-agent-device-for-an-experimental-android-runtime.md). This full contract remains unmet.
