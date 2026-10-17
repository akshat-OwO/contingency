---
status: proposed
---

# Settings live in a strict Catalog Root config

A developer or agent cannot discover Contingency's Settings: most exist only as `CONTINGENCY_*` environment variables read in code, and the README names two of them. Contingency will read non-secret Settings from `config.json` in the Catalog Root and from `~/.contingency/config.json`, validate both strictly against one schema, and publish that schema so a `$schema` field gives editors completion and type checking. Committed files become a public contract, so the location, the secret boundary, and the strictness are recorded here.

## Rules

- **The file follows the Catalog Root.** `CONTINGENCY_CATALOG_ROOT` moves the project file with the catalog. Settings that locate a file, `CONTINGENCY_CATALOG_ROOT` and `CONTINGENCY_GLOBAL_CATALOG_ROOT`, are environment-only, because a file cannot say where it lives.
- **Precedence is flag, environment, project file, user file, default.** The file supplies defaults; process-specific Settings such as ports remain overridable per launch, so concurrent `start` launches do not collide.
- **Secrets never enter the file.** A secret Setting such as `CONTINGENCY_SYSTEM_ONE_API_KEY` is accepted only from the environment, and the schema rejects it. The file holds no Variable values either: a Variable is a Flow Skill input, not a Setting.
- **Validation is strict.** An unknown key, a wrong type, or a forbidden key fails startup with the file path and JSON pointer, as [ADR 0036](./0036-mcp-tool-parameters-reject-excess-properties.md) does for tool parameters. `$schema` is allowed.
- **The schema is generated and pinned.** The JSON Schema and the Settings reference are generated from the Effect Schema that decodes the file, ship in the npm package, and are addressed by a version-pinned unpkg URL. `contingency config init` writes a file holding only that URL and never overwrites one. A `$schema` naming a different version produces a one-line startup warning; the running CLI's schema still decides.
- **One source of documentation serves both readers.** Settings, capabilities, Variables, and limits are markdown topics in the package, readable by the developer on npm or GitHub and by the agent as MCP resources and a `search`-discoverable `docs_get` operation in the code tool. The agent reads effective configuration by reading the files; no Settings tool is added.

## Considered options

- **A `node_modules`-relative `$schema`.** Rejected: `npx` and global installs have no project `node_modules`.
- **An unpinned `@latest` schema URL.** Rejected: it breaks type checking for a project that stays on an older CLI.
- **Ignoring or warning on unknown keys.** Rejected: a misspelled Setting would silently fall back to its default.
