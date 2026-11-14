---
status: accepted
---

# A process owns the devices it starts

> Extends [ADR 0026](./0026-external-agents-control-agent-flows-through-mcp.md) to emulators and simulators. Reverses the "outlives the server" launch from [#688](https://github.com/akshat-OwO/contingency/pull/688).

Workspace can start a stopped emulator or simulator. #688 launched emulators detached so they outlived the server, and nothing stopped a simulator it booted. Users then had to find and stop resource-heavy devices by hand, and Android also opened a native emulator window beside the Workspace stream. ADR 0026 already says a process releases what it acquires when it closes. A device Contingency starts is one of those resources.

## Rules

- **Every Contingency process owns the devices it starts.** This covers the web server and each stdio MCP process that serves its own Workspace. Closing an agent client therefore stops an emulator started from that client's Workspace.
- **Ownership lasts as long as the process.** Finishing a request, closing a browser tab, completing a boot, or closing an Agent Session leaves it in place. A boot that times out, fails after launch, or is interrupted still belongs to the process.
- **The process stops owned devices last.** On normal exit, SIGINT, or SIGTERM, sessions close and release their device connections first. Then the process stops exactly the devices it owns and prints one line per device to stderr, naming any device it left running and why.
- **Ownership is bound to the launch.** An Android launch is its own emulator process group. An iOS boot is the `launchd_sim` process that the boot started. A device that was stopped and started again by someone else, even under the same AVD, serial, or UDID, is not owned.
- **Only a device the process started is owned.** A device that was already running or booting, or that another process started, is waited on and used but never stopped.
- **Devices start headless.** Emulators start with `-no-window` and keep the emulator's own GPU choice. Simulators boot with `simctl boot` and never open Simulator.app. Workspace is the only window. A device that was already running keeps its own window.

## Consequences

- No finalizer runs after SIGKILL or a host crash. A device started before that stays running, and Contingency does not recover it later.
- Contingency still never creates, wipes, resets, or deletes a device, never stops devices by name, and never quits Simulator.app.

> Amended by [ADR 0081](./0081-native-setup-may-clear-app-data-or-erase-a-stopped-device.md): a Device Erase the user allows in Workspace may wipe a stopped device or a running Owned Device.
