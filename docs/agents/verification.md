# Verification during triage and agent work

Contingency's end-to-end verification skill lives at `.cursor/skills/verify-contingency/`. Use it when triaging or implementing anything a user or external agent would see.

## When triage should require it

Add a **verify-contingency** acceptance criterion to an agent brief when the issue touches:

- Workspace, Teaching, or Interactive Runs
- Teaching, Flow learning, Dry Run, verification, catalog listing, or MCP tools
- Browser capture, snapshots, retention, evidence, or Run artifacts

Unit or service tests alone are enough when the change is purely internal — schema encoding, path helpers, or other behavior already covered by integration tests and invisible outside the catalog filesystem.

## Which feature recipe to cite

Read `features/README.md`, then point the brief at the closest recipe:

| Area | Feature file |
| --- | --- |
| Workspace, Teaching, Flow learning, Dry Run, MCP, Run Summary | `features/workspace.md` |

Name the sub-feature or section when the issue is narrow (e.g. "Teaching and Flow learning", "Execution Boundary").

## Agent brief criterion shape

```markdown
- [ ] **End-to-end proof via verify-contingency:** read `.cursor/skills/verify-contingency/SKILL.md` and `features/<recipe>.md`. Drive the relevant path with `control-contingency`. Assert <observable outcome>. Capture evidence under `artifacts/`; run `cleanup`.
```

For filesystem or catalog metadata checks, say where to read after the drive (e.g. `$CONTINGENCY_VERIFY_DIR/state/catalog/...`).

For Teaching capture issues, the observable outcome is the Teaching Timeline, not the Page. Name the exact actions and descriptions `agent_teaching_timeline_get` must return, and require input driven like a person's: Shift, corrections, and a Page that changes while the user types. The drive in #258 checked only the field's final value, and that check missed one `Fill e42` per keystroke.

## Coverage corpus criterion

When the issue touches native observation, Snapshot reading, hit testing, or Teaching click capture, add the matching suite from [Coverage corpora](./testing.md#coverage-corpora) as a criterion:

```markdown
- [ ] **Coverage corpus:** run `<suite>` from `packages/cli` and report the result. A fixed `gap` drops its row's `gap` in the same change. A new native widget pattern adds a captured tree and an expected control to `native-snapshot-corpus.test.ts`.
```

The corpus suites prove that the change holds across many real interfaces. The verify-contingency proof proves the user's path in the live Workspace. A user-visible change needs both.

## Out of scope for the implementing issue

Updating verify-contingency feature files or fixtures belongs in the same change **only when user-visible behavior changed**. Otherwise mark it out of scope and leave maintenance to `maintain-verification-skill`.

## Maintaining the skill

When a change alters accessible names, MCP-visible outcomes, drive steps, or fixture behavior, follow `.cursor/skills/maintain-verification-skill/SKILL.md` in the same PR.
