---
status: accepted
---

# Browser Snapshots read closed shadow roots

Browser Snapshots include controls inside open and closed shadow roots. Agents can act on them through refs, and Teaching names a click on them by role and accessible name. This reverses the boundary that ADRs 0004 and 0012 set: "closed shadow roots are outside the supported recording boundary."

That boundary was set for a reason that no longer applies. PR #8 (issue #7) excluded closed roots because Chrome Recorder–compatible replay had no durable selector that could address them. ADR 0038 removed that replay stack. A Flow is now a written procedure that an agent carries out against a live Browser Snapshot (ADR 0044). A ref is valid only for the current session and document. It is never a stored selector, so a closed root needs no durable address.

Page JavaScript cannot reach a closed root, because `element.shadowRoot` returns `null` in every world. Contingency reads closed roots through CDP, the DOM domain with shadow-piercing traversal, which the runtime already uses through `context.newCDPSession()`. Open roots are read the same way, so both modes go through one traversal. An action on a closed-root ref goes to the node CDP resolved. It keeps the foreground hit-testing rules in ADR 0053.

## Considered Options

- **Keep the boundary and record `Click an unidentified control`.** Rejected: the step is no longer lost, but its intent is. This applies to every closed-root component on design-system pages, and a learned Flow then can't say what the user did.
- **Patch `attachShadow` from an init script to keep closed roots reachable.** Rejected: the patch runs in the page's main world, where the page can detect it and tamper with it. It also misses roots attached before the script runs.

## Consequences

- Redaction of sensitive values and the bounds on page-derived data apply inside shadow roots as they do in the light DOM. A closed root does not make its content trusted.
- Snapshot cost now includes the CDP traversal. Pages with many shadow roots must stay within the existing Snapshot budget.
- Closed roots stay a gap for accessibility Scans. axe-core runs in page JavaScript and still can't see them, so the Scan report's coverage disclosure remains.
