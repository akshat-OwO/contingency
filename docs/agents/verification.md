# Verification during triage and agent work

Contingency's end-to-end verification skill lives at `.cursor/skills/verify-contingency/`. Use it when triaging or implementing anything a user or external agent would see.

## When triage should require it

Add a **verify-contingency** acceptance criterion to an agent brief when the issue touches:

- Workspace, Teaching, or Interactive Runs
- Agent Flow Teaching, verification, approval, catalog search, or MCP tools
- Browser capture, snapshots, retention, evidence, or Run artifacts

Unit or service tests alone are enough when the change is purely internal — schema encoding, path helpers, or other behavior already covered by integration tests and invisible outside the catalog filesystem.

## Which feature recipe to cite

Read `features/README.md`, then point the brief at the closest recipe:

| Area | Feature file |
| --- | --- |
| Workspace, Teaching, verification, approval, MCP, Run Summary | `features/workspace.md` |

Name the sub-feature or section when the issue is narrow (e.g. "Teaching and the draft catalog", "Execution Boundary").

## Agent brief criterion shape

```markdown
- [ ] **End-to-end proof via verify-contingency:** read `.cursor/skills/verify-contingency/SKILL.md` and `features/<recipe>.md`. Drive the relevant path with `control-contingency`. Assert <observable outcome>. Capture evidence under `artifacts/`; run `cleanup`.
```

For filesystem or catalog metadata checks, say where to read after the drive (e.g. `$CONTINGENCY_VERIFY_DIR/state/catalog/...`).

## Out of scope for the implementing issue

Updating verify-contingency feature files or fixtures belongs in the same change **only when user-visible behavior changed**. Otherwise mark it out of scope and leave maintenance to `maintain-verification-skill`.

## Maintaining the skill

When a change alters accessible names, MCP-visible outcomes, drive steps, or fixture behavior, follow `.cursor/skills/maintain-verification-skill/SKILL.md` in the same PR.
