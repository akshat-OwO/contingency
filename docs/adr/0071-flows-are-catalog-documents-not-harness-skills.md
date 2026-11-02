# Flows are catalog documents, not harness skills

> Supersedes the storage layout in ADRs [0039](./0039-flow-skills-are-learned-from-temporary-teaching-recordings.md) and [0044](./0044-agents-own-flow-skill-execution.md), the `.contingency` directory name in ADRs [0049](./0049-permanent-mcp-registration-keeps-project-local-catalogs.md) and [0063](./0063-settings-live-in-a-strict-catalog-root-config.md), and the flat catalog listing in ADRs [0050](./0050-bundled-example-skills-have-distinct-authority.md) and [0051](./0051-workspace-lists-the-user-global-catalog-read-only.md).

A Flow Skill was shaped like a harness skill, with a `SKILL.md` and a `references/` folder, but no Agent Harness ever loads it. Agents reach a Flow only through Contingency, and the shape made the catalog hard to navigate because each Flow's Teaching Recordings and Runs lived elsewhere. We renamed the artifact **Flow** and made each Flow a self-contained directory in a project-level `contingency/` Catalog Root (no leading dot). The user-global catalog stays at `~/.contingency`.

- A Flow directory is marked by its entry document, `flow.md`. It holds the name, description, inputs, and the numbered procedure. Contingency's stamps also go in its frontmatter: hosts, Emulation, runtime, and verification. The stamps record input names but never input values.
- Contingency-owned machine contracts sit beside `flow.md` under reserved names: `checks.json`, `scans.json`, and `browser-state.json`. Markdown may explain them but never replaces them.
- Every other markdown file in the Flow, at any depth, is a supporting document owned by its author. `learn-flow.md` teaches these conventional documents, each written only when the evidence supports it: `setup.md`, `rules.md`, `inputs.md`, `targets.md`, and `recovery.md`. A Run receives `flow.md` and a list of the supporting documents, and fetches each document when it needs it.
- A Flow's Teaching Recordings live in `<flow>/recordings/` and its Runs in `<flow>/runs/`. The agent picks the Flow's name and Group before Start, so a recording is written into place from the beginning. A Run started for exactly one Flow is stored in that Flow, and the location never changes. A Run that used no Flow, or several, goes to the root `contingency/runs/`. Contingency maintains `contingency/.gitignore` so that evidence directories are never committed.
- **Groups** are plain directories at any depth, with no metadata. A Flow's name is unique across its Catalog Root and is its identity, so moving a Flow between Groups breaks no reference.
- Editing `flow.md` or a contract file returns a Verified Flow to drafted. Editing a supporting document does not. A Run never writes Flow documents. It may only propose changes to the user.
- "Flow" replaces "skill" on every surface: MCP tools and parameters, the protocol, the Workspace (the **Flows Drawer**), and onboarding.

## Considered Options

- **Keep the skill shape and move it into `.claude/` or `.agents/`.** We rejected this. Harnesses would load Flows automatically, bypassing the Execution Boundary and the Run lifecycle.
- **Use the relative path as the Flow's identity.** We rejected this. Every regrouping would rename the Flow and break Dry Run prerequisites and Suite membership.
- **Migrate existing `.contingency` catalogs.** We rejected this. The old layout is ignored, and no compatibility documentation is kept.
