# iOS Workspace Teaching and Runs

This branch implements ADR 0067 on the internal iOS Workspace. The complete Support Matrix remains unproven. `CONTINGENCY_IOS_WORKSPACE_INTERNAL=1` exposes the internal Workspace only; public device MCP still returns `ios_support_matrix_unproven`.

## Runtime behavior

The agent can use all semantic controls on its Session Simulator, including system alerts, Settings, other apps, and untaught controls. Simulator identity, current observation, covered targets, controller authority, capture integrity, and lifecycle checks still apply. The framebuffer helper, stream, fresh Session Simulator preparation, recorded-resource scavenging, and scoped cleanup are preserved.

Discovery lists simulators only. A physical selection returns `physical_device_unsupported` before any device command. The selected template supplies device type, runtime, and app build and is never booted or changed.

Variables are ordinary text. Stock agent-device enters every value through the shared `native-app-fill.ts` path. SDK readback success records `confirmed`; unavailable readback records `entered` and `unconfirmed`. The shared native runtime always makes secure-field fills unconfirmed. Runtime evidence carries values; saved skills carry only Variable names. The login fixture teaches a readable Login name and a secure `{{PASSWORD}}` fill, followed by **Sign in privately**, **Open account**, and **Return to account**.

Both Android and iOS use `native-app-confirmation.ts` and the existing Execution Boundary service. An agent action marked `irreversible: true` creates a Pending Decision before dispatch. Workspace displays the exact action. Approval consumes a grant for that stored attempt, refusal dispatches nothing, and every retry requires a fresh decision. Operation receipts prevent duplicate dispatch. This shared-layer change is kept on this branch.

## Verification

The maintained recipe is `.cursor/skills/verify-contingency/features/workspace.md#ios-workspace-internal`. The main proof covers Teaching, Timeline and skill learning, a fresh Dry Run, verification and purge, a later Run, Confirmation Allow and Refuse, duplicate operation readback, and an agent answer to a notification system alert.

On 2026-10-29, quality, CLI/protocol/web typechecks, 804 CLI unit tests (813 after the later fixes), 178 integration tests, and the production framebuffer build passed. The first live iOS 26.5 attempt stopped at the secure Password pick because agent-device 0.21.25 reports the kind `securetextfield`, which `ios-observation.ts` did not map.

Three later attempts ran on iOS 26.5 the same day, one at a time:

- After the mapping fix, Teaching reached **Sign in privately**. The tap dispatched, and then the session paused with `capture_incomplete`. The stream interval recorded no gaps. A direct agent-device reproduction showed that the first snapshot after a password sign-in captures iOS AutoFill's out-of-process sheet as a truncated, sparse tree. The next snapshot is complete. `ios-runtime.ts` now observes a truncated tree again within the existing 30-second capture bound and never acts on it.
- The second attempt reproduced the pause and preserved the evidence.
- The third attempt, with the fix, passed public MCP gating and Teaching. The Timeline returned `fill`, `variable`, and three `activate` entries. The readable fill was `confirmed`, the secure `{{PASSWORD}}` fill was `unconfirmed`, and the stream interval had no gaps. The attempt then stopped at `agent_flow_skill_save`, because step 2 of the proof's authored `SKILL.md` lacks a `Done when:` line.

Step 2 now carries `Done when: Sign in privately is visible.` Three more attempts ran on iOS 26.5 on 2026-10-29, one at a time:

- Attempt 6 passed public MCP gating, Teaching, learning, a `working` Dry Run, and verification and purge. In the later Run, Confirmation Refuse and Allow passed with distinct decisions. The run then paused with `capture_incomplete` after the agent tapped **Request notifications permission**. The alert was on screen. A direct agent-device reproduction showed why: with the alert presented, the snapshot `viewport` is the alert's own frame (320×236), while node rects stay in window points (402×874). The orientation check then saw a landscape viewport against a portrait screenshot on every retry. `ios-runtime.ts` now keeps the app window's viewport when the tree's root is a surface positioned inside it.
- Attempt 7 passed through verification and purge, then paused in the Run with `runtime_failed` around **Sign in privately**. The runtime discarded agent-device's error, so the cause was not recorded. Eight direct sign-ins on an owned simulator did not reproduce it. iOS runtime errors now name the failed step and agent-device's error code and reason, never its message.
- Attempt 8 passed through verification and purge. It paused in the Run on the capture after **Sign in privately** with `runtime_failed during capture (COMMAND_FAILED, invalid-viewport)`. agent-device refuses a snapshot whose runner result has no usable viewport. `ios-runtime.ts` now treats `invalid-viewport` and `missing-viewport` as a stale observation and observes again within the same 30-second bound. A capture that never recovers still ends in `capture_incomplete`.

Attempt 9 ran on 6da3733e, with all three fixes, and passed in one receipt: public MCP gating returned `ios_support_matrix_unproven`; Teaching recorded the readable fill as `confirmed` and the secure `{{PASSWORD}}` fill as `unconfirmed`; learning, a `working` Dry Run, verification and purge, and a later Run passed. In the Run, the agent answered the notification permission alert, and an irreversible action paused for Confirmation: Refuse dispatched nothing, and Allow dispatched exactly once under a distinct decision. Evidence is under `.cursor/skills/verify-contingency/artifacts/ios-0067-attempt9/`; earlier attempts are under `ios-0067-attempt3/` through `ios-0067-attempt8/`. Every attempt's owned template, Session Simulator, servers, browser, and ports were removed. Rotation, live display replacement, Stop races, x64, signing, notarization, clean-host qualification, and both Support Matrix cells are outside this one-host proof.
