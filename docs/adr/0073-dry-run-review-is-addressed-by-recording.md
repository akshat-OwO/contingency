---
status: accepted
---

# Dry Run review is addressed by Teaching Recording

A Dry Run Summary belongs to its Teaching Recording, independently of the Teaching and Dry Run Agent Sessions. Workspace reads it by recording ID beside an ended Dry Run's last frame. The existing Teaching session presentation remains available.

The local viewer uses `/?recording=<recordingId>`. `open_recording` reads persisted evidence and returns a URL on the current MCP process's Workspace. `agent_run_complete` returns that URL for a Dry Run. Agents share it before asking the user to verify or reject. No browser context is restored, and neither read operation can decide for the user. Existing Workspace controls and `agent_flow_decide` retain their explicit user authorization requirements.

The recording viewer and ended Dry Run Summary offer Verify flow and Reject flow when the latest Dry Run passed and the decision is pending. Both use the existing user decision RPCs. Failed or decided reviews offer no decision controls. Read operations and opening or dismissing a review cannot decide. When its Teaching session remains available, the ended Dry Run offers Back to Teaching and selects that session explicitly.

Rejection keeps the latest Summary, scan reports, and video available until another Dry Run starts. Starting that attempt clears the rejected review immediately, so the viewer and video routes cannot show the previous attempt as current evidence. Verification retains the user's decision but removes raw evidence through existing Cleanup. A verified recording's viewer explains that evidence was purged. A URL needs a running local Workspace; after process exit, `open_recording` supplies a URL on the new process's port.

This extends ADRs 0039 and 0041 without creating a durable Run or retaining verified media.
