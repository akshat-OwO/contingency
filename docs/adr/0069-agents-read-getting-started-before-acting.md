---
status: accepted
---

# Agents read getting-started before acting

The `contingency start` work prompt grew with every capability. It repeated tool contracts, drifted from them, and never reached agents that connect through a registered server.

Every agent now reads one short guide, `contingency://docs/getting-started`, before acting. Workflow guides load only when their work begins.

## Rules

- **Three paths point at the guide.** The server instructions name it on every connection. `agent_catalog_get` returns it as `guide`. Every `start` launch sends one message: read `contingency://docs/getting-started` and follow it.
- **Guides are docs topics.** They follow [ADR 0063](./0063-settings-live-in-a-strict-catalog-root-config.md). Each is a `contingency://docs/<topic>` resource and a `docs_get` topic, so a client that cannot read resources still reaches them.
- **A `start` session extends the guide.** Its server serves getting-started with a **This session** section appended: the launch facts, then the work procedure, or the demo onboarding procedure with `--demo`. `docs_get` returns the same text. A registered server, npm, GitHub, and the `/docs` site show the packaged file alone. The procedures live in `onboarding/work-prompt.md` and `onboarding/starter-prompt.md` and repeat no guide. The separate `contingency://start/work-prompt` and `contingency://onboarding/starter-prompt` resources are retired.
- **Agents do not introduce themselves.** No guide or procedure tells the agent to announce itself, its harness, or the launch facts. It raises a launch fact only when a step needs it, such as the Catalog Root when it is unexpected.
- **References must resolve.** A test reads every served prompt and docs topic. It fails on an `agent_*` name the catalog lacks or a `contingency://` URI the server does not serve.
- **Prose stays scannable.** `nub exec turbo run quality` fails on an agent-facing prose block over 3 sentences or 60 words.

## Considered options

- **Keep one long work prompt.** Rejected: it drifts, and registered sessions never see it.
- **Keep separate launch prompt resources.** Rejected: the first message pointed at a prompt, which pointed at the guide, so every launch read two documents before acting.
- **A separate `contingency://guide/` scheme.** Rejected: `docs_get` already serves packaged Markdown to clients without resource support.
- **An Oxlint rule for Markdown.** Rejected: Oxlint parses only JavaScript, so the check runs beside it in the `lint` script.
