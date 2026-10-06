# Workspace lists the user-global catalog read-only

The Workspace's Skills Drawer lists the current Catalog Root and, folded beneath it, the user's `~/.contingency`. Only the Workspace reads the global root: no MCP tool lists, reads, runs, or selects a skill from it, so an agent still never searches a user-global catalog. The drawer is read-only for both roots. It shows Flow Skills, persisted Runs, and Teaching Recording manifests, never videos, Traces, or keyframes, and it starts nothing.

Users keep skills they reuse across projects in `~/.contingency` and could not see them beside a project's own. Letting agents read that root would undo [ADR 0049](./0049-permanent-mcp-registration-keeps-project-local-catalogs.md) and mix unrelated projects' instructions into a Run. Showing it to the user alone gives them the overview without widening what an agent may act on. Using a global skill in a Run stays a deliberate step: the user selects that root, or copies the skill into the project.
