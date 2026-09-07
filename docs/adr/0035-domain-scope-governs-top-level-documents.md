# Domain Scope governs top-level documents only

**Domain Scope** bounds where a Run may take the user, so it is enforced against top-level document navigation and not against subframes. A cross-origin advertising `iframe` is not somewhere the session travels: it cannot move the user, and treating its document load as a scope escape made the **Execution Boundary** pause on ad-supported pages until the user hand-confirmed each frame.

Blocking out-of-scope subframes silently, without pausing, was rejected: it would keep Run evidence deterministic but leave the Boundary enforcing a network policy it does not exist to enforce, on requests no user authorised or would recognise.

## Consequences

Out-of-scope subframes are no longer intercepted at all, so third-party advertising renders during Verification Runs and approved Runs and is captured in Run video, screenshots, and Evidence Slices. Evidence for one Agent Flow may therefore differ between Runs because a third party rotated its content. This is accepted: the evidence shows the page the user's customers actually see.
