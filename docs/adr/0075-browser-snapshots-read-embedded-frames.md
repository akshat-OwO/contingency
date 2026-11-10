---
status: accepted
---

# Browser Snapshots read Embedded Frames

> Amends [ADR 0053](./0053-browser-actions-respect-foreground-interception.md) and [ADR 0074](./0074-browser-snapshots-read-closed-shadow-roots.md). Applies [ADR 0035](./0035-domain-scope-governs-top-level-documents.md) to actions.

Browser Snapshots include the controls inside rendered, visible Embedded Frames, same-origin and cross-origin, nested to any depth, under the existing node limit. Each frame appears as a container node that carries its title and host, and Teaching Timeline entries for actions inside a frame name that host. Agents click and fill through refs that act in the owning frame. Teaching records clicks and typing inside a frame by role and accessible name. Embedded payment fields, sign-in widgets, and 3-D Secure challenges live in frames, so without this a checkout journey can be neither taught nor run, and Teaching drops the step silently.

Acting in an Embedded Frame is not travel. Domain Scope stays a rule about top-level navigation (ADR 0035), so an action in a frame from a host outside the scope does not pause. Confirmation does not depend on frames: an irreversible or high-impact action inside a frame needs Confirmation exactly as it would in the top-level document. A frame never bypasses the Execution Boundary.

A ref belongs to the document it was read from. When an Embedded Frame navigates, the refs read from it and from the frames nested in it expire. A top-level navigation still expires every ref.

## Considered Options

- **Pause the first action in each out-of-scope frame host.** Rejected: every checkout that embeds a payment provider would pause on a host the user never chose and wouldn't recognise. ADR 0035 removed the same failure for advertising frames. The risk lies in the action, and Confirmation already governs actions.
- **Flatten frame content into the tree with no marker.** Rejected: the agent needs to know that a field belongs to a third party, and a learned Flow reads better when it names the payment frame.
- **Read every frame, hidden ones included.** Rejected: ad, tracker, and invisible challenge frames would crowd the node limit. Hidden frames are left out, as hidden elements already are.
- **Expire every ref when any frame navigates.** Rejected: a multi-step payment frame would force a fresh Snapshot of the whole Page on every step.

## Consequences

- Redaction of sensitive values and the bounds on page-derived data apply inside frames as they do in the top-level document. A third-party frame does not make its content trusted.
- Finding closed shadow roots and click listeners in a cross-origin frame needs that frame's own CDP session, because an out-of-process frame is a separate target.
- The handoff property from ADR 0074 now also carries each document's click-listening elements, so listeners are handed over as elements rather than replayed as paths from the top-level document.
- A frame's nodes count against the same budget as the Page's. A frame that does not fit is reported as truncated coverage; a continuation page pages the top-level document, not the frame.
- Done-when phrase matching runs in page script without CDP, so it does not read cross-origin frames. This stays a disclosed gap, as closed shadow roots are for it.
