# Inspect and change browser state

Use browser devtools and apply the permissions for the current activity.

## Devtools

Devtools are available only in single-tool mode through the code tool. With the native interface, use Browser Snapshots and screenshots. Tell the user devtools need `mcp.interface: "single-tool"` and a restart.

Inspect network, console, and storage when useful.

## Permissions

Every Run permits Emulation changes, cookie and storage writes, routes, headers, and mutating evaluation. This includes Guided Run setup and capture and Dry Runs. Mutating evaluation requires Confirmation.

Teaching setup permits Emulation and cookie and storage writes, but not routes, headers, or mutating evaluation. Workspace flags agent-initiated modifications beside the Agent Assessment. They do not cap the assessment; the user's verification decides.

For Guided Run state and its Dry Run, read `contingency://docs/guided-run`.
