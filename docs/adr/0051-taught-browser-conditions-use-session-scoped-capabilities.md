---
status: accepted
---

# Taught browser conditions use session-scoped capabilities

Users need to teach application behavior that the accessibility tree cannot prove, such as a response containing an expected value or a click causing the application to create a cookie. Explicitly taught conditions become durable requirements of the learned Flow Skill, checked during later Runs. The agent retains control of its route and preserves evidence of whether each condition was fulfilled.

The agreed direction is a richer session-scoped browser API behind a small number of MCP tools. Contingency owns the browser context, observation lifetimes, recording, and control ownership. Arbitrary Playwright or CDP access is not required. This preserves the controlled-access decision in [ADR 0026](./0026-external-agents-control-agent-flows-through-mcp.md) and the catalog constraints in [ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md).

During Teaching recording, the agent observes while the user controls the browser. New observation capabilities do not authorize agent clicks, navigation, or storage mutations during recording. A requirement that the application creates a cookie checks application behavior; an agent-created cookie cannot fulfill that requirement.

Authoring extends the Teaching comment composer. Users select an observed network call or a storage key and describe the intended behavior, or provide the instruction in free text. The selected authoring direction is **A · Drag from DevTools** in `apps/web/src/prototypes/composer-attachments/`. It supersedes **1 · Attach** in the earlier `teaching-conditions` gallery. The composer stays non-modal so DevTools remains usable while a comment is drafted.

Plain comments remain the default. Dragging a request or cookie row from DevTools onto the composer adds a context chip. Each row also has a paperclip action. Dropping a response field, or choosing its **Require this value** action, explicitly starts a check for that field. Opening a chip lets the user choose **Context for the agent** or **Must happen** and edit the expectation. Typing a comment alone does not expose action-timing controls.

The composer toolbar keeps element attachment, performance scans, and accessibility scans together. Scan Requirements retain the behavior in [ADR 0048](./0048-teaching-captures-required-scans-for-later-runs.md). The prototype includes mocked scan chips; selecting this authoring direction does not redefine scan execution.

Users can name a cookie that has not appeared in the recording and teach an expectation about that name. Naming a cookie does not mutate browser storage. The application remains responsible for creating it.

Response checks support field existence, typed equality, string containment, and numeric comparisons. Expected values retain their JSON types: `true` differs from `"true"`, and `42` differs from `"42"`. Nested fields are selected through an expandable response tree, with the full selected path and observed value shown separately from the editable expectation.

Array checks ignore ordering by default. A captured index identifies the example item, but the learned check requires a matching item to exist anywhere in the array. Positional matching applies only when the user explicitly specifies an index. The authoring summary must distinguish the observed index from the matching rule used on later Runs.

All predicates grouped into one array-item check must hold on the same item. A check requiring both `reference = "ABC"` and `status = "ready"` cannot pass by finding those values on different orders.

Network-response checks wait for a matching response after the selected action by default. A nonmatching response, such as `pending`, does not fail a check that may later observe `ready`. Users can explicitly choose to check the first response instead.

A required check waits until its configurable timeout. If the check fails, Contingency records the failure and dependent actions stop. The browser remains available for investigation. Failure does not automatically repeat the triggering action, which could duplicate an order or another application effect.

The default timeout is 10 seconds per check and is editable in the composer. The composer shows the deadline. An action-linked watch starts before the action and waits up to that deadline after dispatch.

Future requests match the selected request's method, origin, and path by default. Variable path segments and query-parameter constraints are explicit and editable. The agent can propose replacing an observed identifier with a declared input, but the reviewed check shows the matching rule.

Contingency evaluates structured Browser Checks and prevents a Run from being marked `working` when a required check failed or remains unfulfilled. An observation error is inconclusive rather than proof of an application failure. This extends the assessment model in [ADR 0044](./0044-agents-own-flow-skill-execution.md) and keeps the agent responsible for its route and overall explanation.

A taught expectation that was not observed during the demonstration is retained and labeled **Not demonstrated**. It can be drafted and tested in a Dry Run. Every required check must pass during the Dry Run before the user can verify the Flow Skill. The expected value is not silently replaced with the observed value.

The first version includes network, console, cookie, and storage observation, with taught checks for network responses, cookies, and storage. Console messages support diagnosis only. Taught console checks, including absence-of-error checks, are deferred until their windows and filtering are defined. Agent-driven storage mutations during setup or Runs are a separate extension. Teaching recording remains observation-only.

The external agent receives selected, bounded observations with sensitive values withheld. Conditions can be evaluated locally so that a cookie-existence check does not disclose its value. This extends the observation boundary in [ADR 0032](./0032-external-agents-receive-a-bounded-teaching-feed.md); it does not authorize exporting the raw Trace or unrestricted payloads.

A current-state condition and a condition about a new effect have different meanings. An existing cookie cannot fulfill a requirement that an action creates it. An earlier response cannot fulfill a requirement for a response after the triggering action. Event watches are armed before their triggering action, and cookie-effect checks compare state before and after. Temporal ordering provides evidence of the expected effect, not proof that unrelated concurrent activity could not have caused it.

The agent associates saved check IDs with a triggering browser action. Contingency arms the watches before dispatch, waits within their deadlines, and returns their results alongside the action outcome. Current-state checks run through observation. This extends the controlled browser API without requiring a fixed action sequence or a separate MCP tool for each check type. Existing action authority and operation-id guarantees continue to apply.

## Implementation work remaining

- Define and validate the persisted Browser Check contracts, including typed predicates, nested paths, request identity, and same-item array matching.
- Extend bounded observations with explicit field and payload budgets and sensitive-value withholding. The selected-data policy does not authorize unrestricted payload export.
- Extend action dispatch and observation with check IDs, watch lifetimes, result evidence, timeouts, and retry-safe operation handling.
- Refine the Drag from DevTools composer and learned skill review for typed expectations, multiple predicates, order-independent arrays, request patterns, and timeouts.
- Preserve Browser Check requirements during learning and enforce their results during assessments, Run completion, and Dry Run verification.
- Show evidence-backed check results in Run Summaries and prove the connected behavior through the live verification workflow.

This ADR records the accepted design. It does not describe implemented runtime capabilities. The composer prototypes use mock data and implement only part of the agreed authoring behavior.
