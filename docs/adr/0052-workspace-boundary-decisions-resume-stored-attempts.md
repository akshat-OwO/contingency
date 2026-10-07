---
status: accepted
---

# Workspace boundary decisions resume stored attempts

A paused Execution Boundary offers **Allow** and **Refuse** in Workspace. These gestures resolve the same Pending Decision that an agent can relay through the conversation. The server records whether the decision came from Workspace or the conversation. Allow remains unavailable while the user holds Takeover. Refuse remains available.

Approval authorizes one exact action attempt. It does not dispatch that attempt. The agent resumes it through `agent_browser_resume`, naming the session and boundary. Contingency retains the original action, intent, and operation identity while the attempt waits. The agent no longer has to reconstruct them from a displayed, potentially redacted action. Sequence execution stops at the boundary; resumption performs only that paused action. The agent observes the page before continuing the sequence.

The approval operation and the browser action operation have separate identities. Repeating either exact request returns its recorded result. A changed action cannot reuse an existing action identity. Completed resumption returns the original result without another dispatch. Refused or unknown boundaries fail with instructions to reread the session. Navigation intercepted after dispatch has no undispatched continuation.

A failure before dispatch does not spend the action attempt. A failure or interruption after dispatch may already have affected the website, so its recorded outcome prevents another dispatch under that identity. Takeover invalidates action grants. Resuming after control returns can therefore create a new confirmation decision before dispatch. Terminal receipts, refusal, and session closure release retained action closures, including private input values.

At dispatch, an interruption-masked commit records a spent receipt with an unknown outcome and releases the continuation. A completed result or ordinary failure replaces that receipt. If the caller is cancelled before recording its final outcome, retries return the spent receipt and instruct the agent to inspect the browser. Concurrent resumes wait for the original operation to finish before reading its receipt.

Direct Workspace controls remove a conversation relay when the user is already looking at the paused browser. Keeping the conversation relay supports agents whose user does not have Workspace open. Neither interface grants permission to repeat an irreversible action with a new operation identity.

This partially supersedes the read-only boundary interface in ADR 0037. Per-attempt confirmation, Domain Scope, and exclusive Takeover in ADR 0027 remain.
