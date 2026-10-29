# iOS Workspace Teaching and Runs

This branch implements ADR 0067 on the internal iOS Workspace. The complete Support Matrix remains unproven. `CONTINGENCY_IOS_WORKSPACE_INTERNAL=1` exposes the internal Workspace only; public device MCP still returns `ios_support_matrix_unproven`.

## Runtime behavior

The agent can use all semantic controls on its Session Simulator, including system alerts, Settings, other apps, and untaught controls. Simulator identity, current observation, covered targets, controller authority, capture integrity, and lifecycle checks still apply. The framebuffer helper, stream, fresh Session Simulator preparation, recorded-resource scavenging, and scoped cleanup are preserved.

Discovery lists simulators only. A physical selection returns `physical_device_unsupported` before any device command. The selected template supplies device type, runtime, and app build and is never booted or changed.

Variables are ordinary text. Stock agent-device enters every value through the shared `native-app-fill.ts` path. SDK readback success records `confirmed`; unavailable readback records `entered` and `unconfirmed`. The shared native runtime always makes secure-field fills unconfirmed. Runtime evidence carries values; saved skills carry only Variable names. The login fixture teaches a readable Login name and a secure `{{PASSWORD}}` fill, followed by **Sign in privately**, **Open account**, and **Return to account**.

Both Android and iOS use `native-app-confirmation.ts` and the existing Execution Boundary service. An agent action marked `irreversible: true` creates a Pending Decision before dispatch. Workspace displays the exact action. Approval consumes a grant for that stored attempt, refusal dispatches nothing, and every retry requires a fresh decision. Operation receipts prevent duplicate dispatch. This shared-layer change is kept on this branch.

## Verification

The maintained recipe is `.cursor/skills/verify-contingency/features/workspace.md#ios-workspace-internal`. The main proof covers Teaching, Timeline and skill learning, a fresh Dry Run, verification and purge, a later Run, Confirmation Allow and Refuse, duplicate operation readback, and an agent answer to a notification system alert.

On 2026-10-29, quality, CLI/protocol/web typechecks, 804 CLI unit tests, 178 integration tests, and the production framebuffer build passed. The one live iOS 26.5 attempt passed public MCP gating and Session Simulator preparation, then stopped after the readable fill because no selectable `secure-text-field` named Password appeared in the next snapshot. Confirmation and system-alert steps were not reached. See `.cursor/skills/verify-contingency/artifacts/ios-workspace-runs/receipt.json`, `journal.json`, and `blocked.png`. The script closed the session, verification cleanup stopped the owned servers and browser, and both owned simulator identifiers were deleted. This revision does not have a passing live journey proof. Historical evidence predates these rules and does not qualify this revision. Rotation, live display replacement, Stop races, x64, signing, notarization, clean-host qualification, and both Support Matrix cells are outside this one-host proof.
