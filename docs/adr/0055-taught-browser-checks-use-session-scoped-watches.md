# Taught Browser Checks use session-scoped watches

Status: Accepted

Issue #363 accepts the Drag from DevTools design recorded in [the design snapshot](https://github.com/akshat-OwO/contingency/blob/e854ada5118cc6d89df96b95249b3b27f94fa075/docs/adr/0051-taught-browser-conditions-use-session-scoped-capabilities.md). This ADR records its production contract without replacing the repository's later ADR 0051 decisions.

Browser Attachments default to context. Response-field selection explicitly creates a Browser Check; chip editors review typed predicates, request matching, array grouping, storage change semantics, and the default 10-second deadline. Unobserved expectations stay Not demonstrated. Teaching remains user-controlled.

The learned package retains `references/browser-checks.json` with schemaVersion 1 and every reviewed requirement unchanged. SKILL.md links the file and names each check at its triggering procedure point. Recording Cleanup removes demonstrations while retaining this authored file.

The existing browser action tools accept saved `{flowSkillName,id}` check identities. Contingency resolves declared Variables locally, reads storage baselines, and installs session-context listeners before dispatch. Requests that started before dispatch cannot satisfy a response check. The deadline starts at dispatch. Matching-response mode can observe pending then ready; first-response mode evaluates the first eligible response. Creation and change checks compare their pre-action baseline. Current-state storage checks use the snapshot tool.

Each result records its check, skill, operation, timestamp, status, and a safe explanation. Bounded diagnostics omit query values, headers, bodies, console contents, and storage values. Private expectations use Variable references or existence predicates. No raw-browser evaluation capability or storage mutation is exposed to agents.

Failed, inconclusive, or interrupted checks stop dependent actions while keeping observation and Takeover available. Spent operation replay keeps existing dispatch-once authority. Missing required results prevent working; all requirements must pass before Dry Run verification. Console observations remain diagnostic, and console checks are deferred.

Action results and Teaching timelines use typed codecs with unpublished output shapes, following ADR 0045's catalog budget. Runtime schema validation remains mandatory. Their response contracts remain documented in protocol code and tool descriptions.
