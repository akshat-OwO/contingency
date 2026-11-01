---
status: accepted
---

# Agents read getting-started before acting

The `contingency start` work prompt grew with every capability. It repeated tool contracts, drifted from them, and never reached agents that connect through a registered server.

Every agent now reads one short guide, `contingency://docs/getting-started`, before acting. Workflow guides load only when their work begins.

## Rules

- **Three paths point at the guide.** The server instructions name it on every connection. `agent_catalog_get` returns it as `guide`. The `start` and `start --demo` prompts tell the agent to read it first.
- **Guides are docs topics.** They follow [ADR 0063](./0063-settings-live-in-a-strict-catalog-root-config.md). Each is a `contingency://docs/<topic>` resource and a `docs_get` topic, so a client that cannot read resources still reaches them.
- **Launch prompts hold only launch facts.** The work prompt names the agent, directory, Catalog Root, connection type, and reconnect command. The demo prompt keeps the demo-only flow. Neither repeats a guide.
- **References must resolve.** A test reads every served prompt and docs topic. It fails on an `agent_*` name the catalog lacks or a `contingency://` URI the server does not serve.
- **Prose stays scannable.** `nub exec turbo run quality` fails on an agent-facing prose block over 3 sentences or 60 words.

## Considered options

- **Keep one long work prompt.** Rejected: it drifts, and registered sessions never see it.
- **A separate `contingency://guide/` scheme.** Rejected: `docs_get` already serves packaged Markdown to clients without resource support.
- **An Oxlint rule for Markdown.** Rejected: Oxlint parses only JavaScript, so the check runs beside it in the `lint` script.
