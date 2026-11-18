---
status: accepted
---

# A Web session has its own path

> Decided in [#763](https://github.com/akshat-OwO/contingency/issues/763), from the approved Web session canvas prototype.

A Web session used to live at `/?session=<id>`, the same path as the Workspace home. A session now has its own path, `/<session-id>`, so its URL names it the way a Flow's URL names the Flow.

## Rules

- **`/?session=<id>` still works.** Every MCP `viewUrl` already handed out uses it, and [#740](https://github.com/akshat-OwO/contingency/issues/740) keeps those params fixed. The Workspace redirects it to `/<id>` in place, without adding a history entry. `viewUrl` itself is unchanged.
- **The home and a session share one layout route.** `routes/_workspace.tsx` renders the Workspace for both `/` and `/$sessionId`, so moving between them keeps the Workspace mounted. That keeps the session's stream open and lets the In progress card grow into the stage.
- **Only Web sessions move.** Native sessions keep `/?android=<id>` and `/?ios=<id>`. A Dry Run review keeps `/?recording=<id>`, and `/?run=<id>` still lands on the Flows page.
- **An unknown id is recovered as before.** With a live session, the URL becomes that session's path. With none, the home shows the missing-session notice.
