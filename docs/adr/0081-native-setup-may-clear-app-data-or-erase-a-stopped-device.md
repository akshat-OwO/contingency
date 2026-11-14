---
status: accepted
---

# Native setup may clear app data or erase a stopped device

> Amends [ADR 0066](./0066-ios-simulator-is-the-next-platform-runtime.md) and [ADR 0077](./0077-a-process-owns-the-devices-it-starts.md). Decided in [#716](https://github.com/akshat-OwO/contingency/issues/716).

Native preparation used to keep the Target App's data on purpose, so every session started from whatever the last one left behind. Quickboot snapshots and earlier sessions keep login, local data, and the current screen. A Flow taught from one state was then run against another, and a recording's starting observation could not be trusted. Two new choices let a journey start from a known state. Neither deletes data unless the user agrees to it.

## Rules

- **A Flow saves its Starting Data.** The value is **Keep** (the default) or **Clear**. Teaching, every Dry Run, and every Run apply it, as they apply saved Emulation ([ADR 0054](./0054-saved-emulation-is-a-runtime-requirement.md)). A Flow saved before this rule existed reads as Keep, and its file is not rewritten. A Run cannot override the value. To change it, teach the Flow again.
- **Clear removes only the Target App's own data, and the app stays installed.** Android runs `pm clear` for owner user 0 after install and before permissions and launch. iOS terminates the app and empties its `simctl get_app_container … data` folder, then applies privacy decisions and launches it. This works without an uploaded build. iOS Keychain items and app-group folders survive, and the iOS Support Matrix documents that limit.
- **A Clear Flow clears again right before Start recording.** Setup may still change device Settings and other apps. Any app state that setup creates, such as a sign-in, is removed, so the recording starts where every Run starts. A Clear Flow teaches its own sign-in or uses Variables.
- **The user consents to Clear once, at Teaching setup.** The confirmation names what is lost: login state and local data, for that app only. After that, the saved Flow carries the consent. Dry Runs and Runs apply it without asking, and each Run Summary records the Starting Data it applied. An agent may request Clear as a Pending Decision, which the user can allow in Workspace or over MCP ([ADR 0037](./0037-pending-decisions-relay-user-consent-over-mcp.md)).
- **Device Erase is a one-time setup action that a Flow never saves.** Android boots with `-wipe-data`. iOS runs `simctl erase` and then boots. The device then boots as an Owned Device, and Contingency's helper is reinstalled under its existing grant. Erase applies to a stopped device or a running Owned Device. A running device the process does not own is refused, because stopping it would break ADR 0077. No Dry Run or Run erases a device.
- **Only a Workspace click allows Device Erase.** An agent may request it as a Pending Decision, but the decision cannot be allowed over MCP. A relayed approval that erases every app and account on the device costs too much when the agent is wrong.

## Considered options

- **Set Starting Data per session.** Rejected. A Flow taught from clean data would silently run against stale data, which is the failure this ADR fixes.
- **Clear iOS data by uninstalling and reinstalling.** Rejected. It needs the `.app` uploaded again in every session and still keeps the Keychain. Emptying the data folder in place works the same in every session, with or without an uploaded build.
- **Cold boot without the snapshot.** Rejected as a reset. App data lives on the userdata partition and survives every boot. Only `-wipe-data` resets it.

## Consequences

- ADR 0066's rule that a journey starts from the app's existing data now holds only for Keep.
- ADR 0077's statement that Contingency "never wipes or resets a device" now has one exception: a Device Erase the user allowed in Workspace. Contingency still never creates or deletes a device, never stops a device it does not own, and never quits Simulator.app.
