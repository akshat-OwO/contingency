# Use a device

Start an Android or iOS device session for a supported platform.

## Start

Call `agent_device_workspace` with the requested platform. Follow its contract and the platform's Support Matrix; offer only platforms reported available by `agent_catalog_get`.

Android supports API levels 30 through 36. Its actions target semantic elements rather than raw coordinates. Device availability and supported actions are subject to the runtime's reported limits.

## Wait for the user

Native sessions have no Session Events, so `agent_session_get` cannot find them. After you ask the user to act in the Workspace, reread the session with the `read` command of `agent_device_workspace` every few seconds. Compare each read with the last one: Workspace actions on the session increase the snapshot's `revision`, and a verify or reject decision changes `captureState` without changing `revision`.
