# Storage mutations are live-only screwdriver operations

Create View Storage inspects and mutates the current tab’s top-level origin cookies, `localStorage`, and `sessionStorage`. Mutations are live screwdriver operations on that browser. They are never Flow Steps, never part of a Recording, and never a glossary term.

While a Recording exists for that browser session and `phase !== "finished"` (`active`, `paused`, or `incomplete`), inspect stays on and mutate is off in both the UI and the CLI. Get RPCs remain allowed. The lock is session-scoped: another Create View browser session can still mutate.

Inspect-only was rejected because authors need to reset origin state between Recordings. Flow-level storage Steps and agent-browser `state save/load` were deferred.

## Consequences

- Replay does not depend on inspector clicks. Storage changes are not captured as Steps.
- Pause and recover are not windows to desync the browser from the Recording.
- Origin cookie clear deletes each in-scope cookie. `cookies clear` is not used, because that command wipes the whole browser context.
- CDP stays off the web UI ([ADR 0004](./0004-cli-owned-cdp-recorder-sidecar.md)). The web app talks Effect RPC; the CLI AgentBrowser adapter wraps bundled agent-browser `cookies` and `storage local|session`.
