# Pending Decisions relay user consent over MCP

Contingency represents an in-scope user choice as a server-issued **Pending Decision**. Session and Agent Flow revision snapshots expose each open decision's id, kind, scope summary, Agent Flow id, revision id, and related session id. The external agent presents that scope in its conversation and calls `agent_pending_decision_resolve` only after the user explicitly chooses. Agent View mirrors pending and resolved status but does not authorize verification or approve revisions.

Resolution requires a `pendingDecisionId`, an operation id, and a decision enum. `authorize_verification` accepts `authorize` or `refuse`; `approve_flow` accepts `approve` or `refuse`. An optional `userMessage` is audit context, not proof. The agent must ask a follow-up question instead of resolving an ambiguous reply. Unknown, invalidated, or already resolved ids return `agent_flow_conflict`. Replaying the same operation id and request returns the original result.

Pending ids bind consent to one exact draft revision. Saving another draft invalidates the old authorization decision. Starting verification spends authorization. A passed Verification Run replaces verification state with an approval decision; a failed Run creates a fresh authorization decision. Approval moves the exact verified draft to the approved head. Refusing authorization removes the pending decision without authorizing anything. Refusing approval records that choice and replaces the consumed id with a fresh approval decision, so the passed revision remains intact and can still be approved after a later explicit choice. Pending Decisions have no time-to-live. Domain events invalidate them.

Every resolution appends a durable audit record with the pending id, kind, decision, operation id, timestamp, Agent Flow id, revision id, and optional quoted user message. Secret values never enter this record.

The conversation is the consent interface because it is where the user already directs the external agent. Requiring a second Agent View click for each verification cycle added context switching without adding a stronger identity or authentication check. Agent View remains the right interface for browser Takeover and other gestures that have not moved to Pending Decisions.

## Considered options

- **Keep authorization and approval buttons in Agent View**: rejected because every cycle forces a window switch while the MCP conversation already carries the user's explicit direction.
- **Treat a quoted user message as consent**: rejected because free text is ambiguous and the agent could fabricate or misread it. The enum is the server input; the quote is audit context only.
- **Let the agent authorize by naming a revision directly**: rejected because a revision id says what to change, not which user choice is currently open. A server-issued pending id ties the resolution to state the user was asked to review.
- **Expire pending decisions on a timer**: rejected because elapsed time does not describe whether the draft or Verification Run changed. Domain events provide the actual invalidation rule.
