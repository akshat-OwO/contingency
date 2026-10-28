---
status: accepted
---

# iOS Simulator is the next platform runtime

Users want to teach and verify iOS journeys the way they already do on Android. Extend Contingency to the iOS Simulator through the native-app layer that [ADR 0058](./0058-android-is-the-next-platform-runtime.md) anticipated, and support it only within an iOS Support Matrix. iOS skips Android's experimental opt-in from [ADR 0060](./0060-use-stock-agent-device-for-an-experimental-android-runtime.md): its MCP surface and Workspace entry stay unlisted until every cell of the matrix passes. Verification on one platform still does not verify a journey on another, and web, Android, and iOS keep separate Flow Skills.

## Rules

- **Simulator only.** iPhone simulators on macOS with Xcode are the only supported devices. Physical iPhones and iPads are documented limits, and selecting one is refused.
- **Stock agent-device drives iOS.** Use the pinned agent-device that already drives Android, which uses an accessibility bridge for Simulator snapshots and XCTest for input. Build our own pieces only where a Contingency contract fails, as [ADR 0061](./0061-android-private-text-uses-a-contingency-owned-helper.md) did.
- **Teaching uses the Workspace mirror.** The user teaches through the simulator screen streamed into Workspace, and all input passes through session authority. Clicks made directly in Simulator.app are outside the capture contract. expo-device-hub has no iOS support, so the stream backend is conditional on a spike that proves timing, loss detection, and Start-to-Stop interval ownership.
- **Private Variables are required.** A private fill must pass the [ADR 0061](./0061-android-private-text-uses-a-contingency-owned-helper.md) sentinel test: a generated value never appears in process arguments, logs, or diagnostics. Until stock agent-device's text transport passes, Contingency refuses secrets on iOS. If it fails, Contingency adds its own text path.
- **Each session runs on a Session Simulator.** The selected simulator supplies only its device type, runtime, and installed app bundle. Each Agent Session binds to a new simulator created with that device type and runtime, installs a fresh copy of the Target App, and deletes the simulator when it ends. The selected simulator is never booted or changed, so its app data, settings, and other apps never reach a session. The trade-off is a cold first boot per session. `simctl clone` was rejected: a booted clone keeps absolute paths to its source in symlinks and system databases such as the LaunchServices store, and writes into the source through them. On iOS 26.5, booting a clone changed 83 files in the shut-down source, and still changed 102 after the clone's symlinks were rewritten.
- **App builds come from a path or the template.** The user names a simulator `.app` build, or an app already installed on the selected simulator, whose bundle Contingency copies out and installs fresh.
- **The taught environment is device type, runtime, bundle identifier, and build.** Changes to the iOS runtime version, the build, or the bundle identifier need Run Environment Permission. Explicit selection authorizes a different device type.
- **iOS has no Back action.** Journeys go back through the app's own navigation controls. The edge-swipe gesture is a documented limit.
- **Limits mirror Android.** Raw coordinates are refused. One live session binds one simulator. System alerts and other apps pause the Run on `ownership_unknown`. `secure_window` does not apply to iOS.
- **Host prerequisites fail before any device command.** Discovery refuses with `host_unsupported`, `xcode_missing`, `runtime_missing`, or `os_unsupported`. agent-device builds its XCTest runner on first selection with visible progress. No install consent is asked, because the runner and the app are installed only into the Session Simulator.

## Support Matrix

Two cells, each with a current iPhone simulator: iOS 27.1 and iOS 26.5. Selection accepts iOS 26 through 27. The journey matches Android's [login fixture](../reports/android-support-matrix.md), built for the simulator: a public fill, a `{{PASSWORD}}` private fill, **Sign in privately**, **Open account**, and back through the app's navigation button. Each cell must pass Teaching, a `working` Dry Run, verification with Cleanup, a later Run, and every documented-limit refusal.

## Platform-neutral services and tools

Extract a shared native-app layer from the Android services for session lifecycle, observation, actions, Run Environment Permission, and Teaching capture. Discovery, preparation, and streaming stay platform modules. The MCP tools become `agent_device_workspace` and `agent_device_sessions_list` with a `platform: "android" | "ios"` field. The `agent_android_*` names are removed without aliases, because a second platform's tools would otherwise add about 7 KB to every client's catalog ([ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md)). Workspace shows an **iOS** button beside **Android**.

## Consequences

Session Simulators are released through scoped finalizers on every exit that runs them. A hard kill, OOM, or power loss skips finalizers and would leave a multi-gigabyte simulator behind. Contingency therefore records each Session Simulator's identifier with its owning process before it boots, and erases the record after deletion. Independent Contingency processes may run at once, so a record proves ownership but not abandonment. At startup, Cleanup deletes a recorded Session Simulator only when its owning process is no longer alive, using the same owner-liveness rule as other Agent Session resources. It never deletes a simulator by name.
