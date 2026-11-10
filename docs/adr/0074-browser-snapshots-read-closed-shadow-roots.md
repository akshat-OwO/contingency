---
status: accepted
---

# Browser Snapshots read closed shadow roots

> Amends [ADR 0004](./0004-cli-owned-cdp-recorder-sidecar.md), [ADR 0012](./0012-playwright-is-the-in-process-browser-runtime.md), and [ADR 0053](./0053-browser-actions-respect-foreground-interception.md).

Browser Snapshots include controls inside open and closed shadow roots. Agents can act on them through refs, and Teaching names a click on them by role and accessible name. This reverses the boundary that ADRs 0004 and 0012 set: "closed shadow roots are outside the supported recording boundary."

That boundary was set for a reason that no longer applies. PR #8 (issue #7) excluded closed roots because Chrome Recorder–compatible replay had no durable selector that could address them. ADR 0038 removed that replay stack. A Flow is now a written procedure that an agent carries out against a live Browser Snapshot (ADR 0044). A ref is valid only for the current session and document. It is never a stored selector, so a closed root needs no durable address.

Page JavaScript cannot reach a closed root, because `element.shadowRoot` returns `null` in every world. Before each Snapshot read, Contingency finds closed roots through CDP with a shadow-piercing `DOM.getDocument`, using the CDP session the runtime already opens through `context.newCDPSession()`. CDP resolves each root and puts the roots on a document property with a random, non-enumerable name. The Snapshot read deletes that property before it reads anything else, and a failed read deletes it too. The read then walks open and closed roots as one tree. Refs inside a root are ordinary element handles, so actions on them keep the foreground hit-testing rules in ADR 0053. Hit testing also reads the closed roots between a target and the document, which it learns from the target.

## Considered Options

- **Keep the boundary and record `Click an unidentified control`.** Rejected: the step is no longer lost, but its intent is. This applies to every closed-root component on design-system pages, and a learned Flow then can't say what the user did.
- **Patch `attachShadow` from an init script to keep closed roots reachable.** Rejected: the patch is a lasting change to a page API, so the page can detect it and tamper with it for its whole life. It also misses roots attached before the script runs. The handoff property is visible only during one Snapshot read, it changes no API, and it gives the page nothing the page does not already own.
- **Run the whole Snapshot over CDP.** Rejected: refs are Playwright element handles, and Playwright offers no public way to adopt a CDP object. The Snapshot read and every action would need a second implementation.

## Consequences

- Redaction of sensitive values and the bounds on page-derived data apply inside shadow roots as they do in the light DOM. A closed root does not make its content trusted.
- Each Snapshot now also runs a shadow-piercing CDP document read, alongside the existing listener read. On a page without shadow roots, Snapshot time matches the previous implementation within measurement noise.
- Done-when phrase matching runs without CDP, so it reads open roots and not closed ones.
- Closed roots stay a gap for accessibility Scans. axe-core runs in page JavaScript and still can't see them, so the Scan report's coverage disclosure remains.
