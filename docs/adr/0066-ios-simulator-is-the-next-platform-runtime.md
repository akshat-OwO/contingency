---
status: accepted
---

# iOS Simulator is the next platform runtime

Users want to teach and verify iOS journeys the way they already do on Android. Extend Contingency to the iOS Simulator through the native-app layer that [ADR 0058](./0058-android-is-the-next-platform-runtime.md) anticipated, and support it only within an iOS Support Matrix. iOS skips Android's experimental opt-in from [ADR 0060](./0060-use-stock-agent-device-for-an-experimental-android-runtime.md): its MCP surface and Workspace entry are listed after both cells of its [Support Matrix](../reports/ios-support-matrix.md) passed. iOS Simulator is supported within that matrix. iOS follows [ADR 0067](./0067-runtimes-trade-privacy-and-app-boundaries-for-reach.md) from the start: Variables are plain text, and the agent may use the whole simulator OS. Verification on one platform still does not verify a journey on another, and web, Android, and iOS keep separate Flow Skills.

## Rules

- iOS requires an Apple Silicon Mac. Intel Macs are refused with `host_unsupported`.

- **Simulator only.** iPhone simulators on macOS with Xcode are the only supported devices. Selecting a physical iPhone or iPad is refused with `physical_device_unsupported` before any device command.
- **Stock agent-device drives iOS.** Use the pinned agent-device that already drives Android, which uses an accessibility bridge for Simulator snapshots and XCTest for input. Build our own pieces only where a Contingency contract fails, such as streaming the simulator screen.
- **The CLI ships the framebuffer helper.** Release and PR artifact CI build an ad hoc signed arm64-only executable on macOS and pack it with a versioned SHA-256 manifest on Ubuntu. Runtime checks the exact packed digest and the single arm64 Mach-O executable slice before launch. The adjacent manifest detects binary corruption, not publisher identity; npm provenance supplies package origin evidence. Users do not compile the framebuffer helper.
- **Teaching uses the Workspace mirror.** The user teaches through the simulator screen streamed into Workspace, and all input passes through session authority. Clicks made directly in Simulator.app are outside the capture contract. expo-device-hub has no iOS support, so the stream backend is conditional on a spike that proves timing, loss detection, and Start-to-Stop interval ownership.
- **Variables are plain text.** Stock agent-device types every value. A fill is confirmed when the field can be read back. A secure text field cannot be, so its fill is entered but unconfirmed, and the journey's outcome decides the assessment.
- **Each session binds to the selected simulator.** As Android uses the selected emulator, an Agent Session uses the simulator the user selects. Contingency does not copy, create, or reset simulators. Before Teaching or a Run, it installs the authorized build if one is named and restarts the Target App, so a journey starts from the app's existing data. Creating a disposable simulator per session was rejected: its cold first boot dominated every session on a laptop, and Android already accepts the selected device's state. `simctl clone` was also rejected, because a booted clone writes into its source through absolute paths.
- **Starting permission states are declared.** The taught environment may declare the Target App's starting permission states. After the optional install and before launch, preparation applies each with `xcrun simctl privacy <selected UDID> grant|revoke|reset <service> <Target App bundle>`. A service `simctl privacy` lacks, such as notifications, is refused with `permission_service_unsupported` before any device command.
- **App builds come from a path or the template.** The user names a simulator `.app` build to install, or uses the app already installed on the selected simulator.
- **The taught environment is device type, runtime, bundle identifier, build, and declared permission states.** Changes to the iOS runtime version, the build, the bundle identifier, or the declared permission states need Run Environment Permission. Explicit selection authorizes a different device type.
- **iOS has no Back action.** Journeys go back through the app's own navigation controls. The edge-swipe gesture is a documented limit.
- **The agent uses the whole simulator within documented iOS limits.** The Target App identifies what the journey tests. System alerts over the Target App and controls Teaching never recorded are supported. Other apps, Settings included, are a documented iOS limit until agent-device can observe whichever app is in front. Observation never activates the Target App: it refuses with `foreign_app_foreground`, and **Return to Target App** brings the existing app forward without relaunching it. Teaching capture pauses until the user returns. Runs never pause on `ownership_unknown`. An action the agent marks irreversible or high-impact pauses for Confirmation, which allows exactly one attempt.
- **Limits mirror Android.** Raw coordinates are refused. One live session binds one simulator. `secure_window` does not apply to iOS.
- **Host prerequisites fail before any device command.** Discovery refuses with `host_unsupported`, `xcode_missing`, `runtime_missing`, or `os_unsupported`. agent-device builds its XCTest runner on first selection with visible progress. Installing a named build on the selected simulator is a separate decision, as installing an APK is on Android.

## Support Matrix

Two cells, each with a current iPhone simulator: iOS 27.1 and iOS 26.5. Both cells passed on 2026-10-29. See the [matrix report and receipts](../reports/ios-support-matrix.md). Selection accepts iOS 26 through 27. The journey matches Android's [login fixture](../reports/android-support-matrix.md), built for the simulator: a public fill, a `{{PASSWORD}}` fill into a secure field, **Sign in privately**, **Open account**, and back through the app's navigation button. Each cell must pass Teaching, a `working` Dry Run, verification with Cleanup, a later Run, and every documented-limit refusal. Its proof must also show the agent answering a system alert and a Confirmation pause.

## Platform-neutral services and tools

Extract a shared native-app layer from the Android services for session lifecycle, observation, actions, Run Environment Permission, and Teaching capture. Discovery, preparation, and streaming stay platform modules. The MCP tools become `agent_device_workspace` and `agent_device_sessions_list` with a `platform: "android" | "ios"` field. The old Android-specific tool names are removed without aliases, because a second platform's tools would otherwise add about 7 KB to every client's catalog ([ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md)). Workspace shows an **iOS** button beside **Android**.

## Consequences

The selected simulator's data changes across sessions, as an Android emulator's does. A journey that needs a particular starting state declares it through setup rather than relying on a fresh install.
