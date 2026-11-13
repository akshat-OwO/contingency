---
status: accepted
---

# Native Runs end with a platform-tagged Run Summary

An Agent Session dies with its process, while its Run outlives it. Android and iOS Runs and Dry Runs kept their only durable result in the device session's own record, so a closed native session stayed in the session picker as the sole way back to that result (#696). Instead, every native Run or Dry Run that reached `running` writes a Run Summary into its own Run directory when it ends, filed as the Run store files a single-Flow Run, and the Flows Drawer lists it beside browser Runs. The native Run Summary is its own version, tagged with its platform, in the `CatalogRunSummary` union the Catalog Root holds; the browser `AgentRunSummary` stays browser-only. The Flows Drawer opens a native Run in its device session's ended Workspace view. The session picker then lists only sessions their process still owns.

## Considered Options

- **List native session records as Runs.** The catalog browser would read `.android-workspace` and `.ios-workspace` records directly. Rejected: the Run would then depend on a record that exists to coordinate one process's session, and every reader of Runs would need to know each platform's session format.
- **Fit native Runs into the browser `TaskAgentRunSummary`.** Rejected: it requires browser-only evidence such as starting Emulation, browser checks, and a Trace, which a native Run would have to fake.
- **Add the native Run Summary to the browser `AgentRunSummary` union.** Rejected: every browser reader of a Run, such as its video, Trace, and `open_run`, would then have to refuse it.

## Consequences

- A native Run closed while still `pending`, or refused, writes no Run Summary: nothing ran.
- Native Runs that ended before this decision have no Run Summary and are not backfilled. A direct link to their session still shows the ended session.
