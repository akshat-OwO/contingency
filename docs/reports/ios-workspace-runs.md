# iOS Workspace Teaching and Runs

This branch implements ADR 0067 on the internal iOS Workspace. The complete Support Matrix remains unproven. `CONTINGENCY_IOS_WORKSPACE_INTERNAL=1` exposes the internal Workspace only; public device MCP still returns `ios_support_matrix_unproven`.

## Runtime behavior

The agent can use all semantic controls on its Session Simulator, including system alerts, Settings, other apps, and untaught controls. Simulator identity, current observation, covered targets, controller authority, capture integrity, and lifecycle checks still apply. The framebuffer helper, stream, fresh Session Simulator preparation, recorded-resource scavenging, and scoped cleanup are preserved.

Discovery lists simulators only. A physical selection returns `physical_device_unsupported` before any device command. The selected template supplies device type, runtime, and app build and is never booted or changed.

Variables are ordinary text. Stock agent-device enters every value through the shared `native-app-fill.ts` path. SDK readback success records `confirmed`; unavailable readback records `entered` and `unconfirmed`. The shared native runtime always makes secure-field fills unconfirmed. Runtime evidence carries values; saved skills carry only Variable names. The login fixture teaches a readable Login name and a secure `{{PASSWORD}}` fill, followed by **Sign in privately**, **Open account**, and **Return to account**.

Both Android and iOS use `native-app-confirmation.ts` and the existing Execution Boundary service. An agent action marked `irreversible: true` creates a Pending Decision before dispatch. Workspace displays the exact action. Approval consumes a grant for that stored attempt, refusal dispatches nothing, and every retry requires a fresh decision. Operation receipts prevent duplicate dispatch. This shared-layer change is kept on this branch.

## Verification

The maintained recipe is `.cursor/skills/verify-contingency/features/workspace.md#ios-workspace-internal`. The main proof covers Teaching, Timeline and skill learning, a fresh Dry Run, verification and purge, a later Run, Confirmation Allow and Refuse, duplicate operation readback, and an agent answer to a notification system alert.

On 2026-10-29, quality, CLI/protocol/web typechecks, 804 CLI unit tests, 178 integration tests, and the production framebuffer build passed. The first live iOS 26.5 attempt stopped at the secure Password pick because agent-device 0.21.25 reports the kind `securetextfield`, which `ios-observation.ts` did not map.

Three later attempts ran on iOS 26.5 the same day, one at a time:

- After the mapping fix, Teaching reached **Sign in privately**. The tap dispatched, and then the session paused with `capture_incomplete`. The stream interval recorded no gaps. A direct agent-device reproduction showed that the first snapshot after a password sign-in captures iOS AutoFill's out-of-process sheet as a truncated, sparse tree. The next snapshot is complete. `ios-runtime.ts` now observes a truncated tree again within the existing 30-second capture bound and never acts on it.
- The second attempt reproduced the pause and preserved the evidence.
- The third attempt, with the fix, passed public MCP gating and Teaching. The Timeline returned `fill`, `variable`, and three `activate` entries. The readable fill was `confirmed`, the secure `{{PASSWORD}}` fill was `unconfirmed`, and the stream interval had no gaps. The attempt then stopped at `agent_flow_skill_save`, because step 2 of the proof's authored `SKILL.md` lacks a `Done when:` line.

Learning, the Dry Run, verification and purge, the later Run, Confirmation, and the system alert were not reached. This revision does not have a passing live journey proof. Evidence is under `.cursor/skills/verify-contingency/artifacts/ios-0067-attempt3/` through `ios-0067-attempt5/`. Every attempt's owned template, Session Simulator, servers, browser, and ports were removed. Historical evidence predates these rules and does not qualify this revision. Rotation, live display replacement, Stop races, x64, signing, notarization, clean-host qualification, and both Support Matrix cells are outside this one-host proof.
