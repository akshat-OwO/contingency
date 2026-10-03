# Permanent MCP registration keeps project-local catalogs

Registering Contingency for all projects makes its tools available across projects, while each session uses its current project's `.contingency` Catalog Root. A missing catalog starts a new project-local catalog rather than reusing the original project's Flow Skills or evidence. Only the absence of a usable current project directory permits fallback to the original onboarding directory, which the agent names before using it.

Always using the original catalog would make registration simpler, but would mix unrelated projects' reusable instructions and local evidence. Current project selection preserves the Catalog Root boundary; the saved fallback supports clients that cannot identify a current project.
