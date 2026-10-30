# iOS discovery and selected simulator preparation

[ADR 0066](../adr/0066-ios-simulator-is-the-next-platform-runtime.md) binds each session to the user's selected simulator. This implementation replaces the earlier disposable-device preparation for [issue 547](https://github.com/akshat-OwO/contingency/issues/547).

## Behavior

Discovery checks macOS, full Xcode, an available runtime, and iOS 26 through 27. It preserves `host_unsupported`, `xcode_missing`, `runtime_missing`, `os_unsupported`, and `physical_device_unsupported` refusals before device commands. It lists stopped simulators but refuses their apps and preparation with `device_stopped`. The user starts the simulator and refreshes, matching Android's stopped-emulator selection policy in `apps/web/src/components/agent/android-setup-state.ts`.

Preparation rechecks the selected device identity and environment. An explicitly named `.app` authorizes installation. Preparation copies that build into its private host directory, checks its bundle identifier and build, installs it on the selected simulator, and verifies the installed build. With no path, it uses the existing installed app without copying or installing it. It then terminates and launches the Target App. An already stopped app is accepted only when simctl reports that it found nothing to terminate. Existing app data and permission choices remain the starting state.

This follows Android's `android-discovery.ts`, `android-startup.ts`, `android-preparation.ts`, and `android-session-lifecycle.ts`. Contingency never creates, clones, resets, boots, shuts down, or deletes a simulator. Closing or failing a session stops its private agent-device runner and daemon and removes its temporary host directory. The selected simulator stays running. A failed runner stop retains its host directory for diagnosis. There are no simulator owner records or startup scavenging.

## Verification

`packages/cli/tests/services/ios.test.ts` covers prerequisite refusals, stopped selection, identity and environment changes, optional installation, terminate-before-launch, runner failure, launch failure, interruption, and selected-device preservation. All device operations use the injected service.

Run the repository quality and type checks and CLI unit suite. The live preparation helper accepts an already running proof-owned simulator:

```sh
CONTINGENCY_IOS_SELECTED=<owned-udid> nub packages/cli/scripts/verify-ios-preparation.ts /absolute/Fixture.app
```

It checks that existing app data survives a later session without installation, the simulator inventory is unchanged, and closing leaves the selected simulator running. It creates or deletes no devices. The caller owns the selected proof device and its cleanup.

The full Workspace proof and current evidence are recorded in `docs/reports/ios-workspace-runs.md` on the next stack layer. iOS remains unlisted until the Support Matrix passes. Historical fresh-device receipts establish only the previous implementation.
