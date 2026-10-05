# Matt Pocock skills v1.3 comparison

Checked on 2026-10-04 against [mattpocock/skills v1.3.0](https://github.com/mattpocock/skills/releases/tag/v1.3.0), commit `984a2c023c9fb42bb6ea40c70a652284a109dc05`. Comparisons cover whole skill directories, including reference files and agent metadata.

[v1.3.1](https://github.com/mattpocock/skills/releases/tag/v1.3.1), commit `24fe0ef7737efae15c87225755e9f6f5965e4888`, followed the same day. Its only skill change corrects `ask-matt`'s stale description of the bug-diagnosis handoff. It does not change any skill installed here.

## Repository skills

| Location | Skill | Difference from Matt's v1.3.0 |
| --- | --- | --- |
| `packages/cli/skills/` | `writing-for-agents` | Same body and `SKILL-MECHANICS.md`. Description targets Contingency Flow Skills. Omits upstream `agents/openai.yaml`. |
| `packages/cli/skills/` | `technical-writing`, `unslop` | Absent from Matt's release. Both match the globally installed bodies, with descriptions scoped to Contingency Flow Skills. |
| `.agents/skills/` | `ultracite` | Absent from Matt's release. `skills-lock.json` records `haydenbleasel/ultracite` as its source. |
| `.cursor/skills/` | `verify-contingency`, `maintain-verification-skill` | Project-specific skills absent from Matt's release. `.agents/skills/` and `.claude/skills/` expose these through symlinks. |
| `packages/cli/examples/` | `example-broken-cart`, `example-cart-scan`, `example-delivery-cart`, `example-signed-in-return` | Product Flow Skills absent from Matt's release. |

The bundled `writing-for-agents` frontmatter differs as follows. Upstream is the removed line; the repository is the added line.

```diff
-description: Writing documents for agents. Use when creating or editing skills, or modifying AGENTS.md or CLAUDE.md.
+description: Writing documents for agents. Use when writing a Contingency Flow Skill's SKILL.md or a file under its references/.
```

The omitted upstream metadata contains only a display name and short description. The repository's Flow Skill triggers and packaging remain unchanged.

## Globally installed Matt skills

These live under `~/.agents/skills/`, outside this repository.

| Skill | Comparison before this update |
| --- | --- |
| `codebase-design` | Identical |
| `domain-modeling` | Identical |
| `grill-me` | Identical |
| `grill-with-docs` | Identical |
| `grilling` | Identical |
| `improve-codebase-architecture` | Identical |
| `setup-matt-pocock-skills` | Identical, including every seed template |
| `writing-for-agents` | Identical |
| `triage` | One stale glossary filename in step 4. Fixed during this update. |

The entire global skill difference was:

```diff
-4. **Grill (if needed).** If the request needs fleshing out, call the Skill tool twice, for "grilling" and "domain-modeling", and grill it into shape a round of questions at a time, sharpening domain terms and updating `GLOSSARY.md`/ADRs inline as decisions land.
+4. **Grill (if needed).** If the request needs fleshing out, call the Skill tool twice, for "grilling" and "domain-modeling", and grill it into shape a round of questions at a time, sharpening domain terms and updating `CONTEXT.md`/ADRs inline as decisions land.
```

Upstream is the removed line; the installed copy before correction is the added line. After correction, all nine installed Matt skill directories match v1.3.0.

The following released skills are absent from `~/.agents/skills/`:

- Engineering: `ask-matt`, `code-review`, `diagnosing-bugs`, `implement`, `implement-spec`, `pr`, `prototype`, `research`, `retro`, `tdd`, `to-spec`, `to-tickets`, `wayfinder`, `wizard`.
- Productivity: `handoff`, `teach`, `to-questionnaire`, `wait-what`.
- Miscellaneous: `git-guardrails-claude-code`, `migrate-to-shoehorn`, `scaffold-exercises`, `setup-pre-commit`.
- In progress: `claude-handoff`, `loop-me`, `setup-ts-deep-modules`, `writing-beats`, `writing-fragments`, `writing-shape`.

Global skills absent from Matt's release are `babysit`, `better-ui`, `create-pr`, `create-verification-skill`, `emil-design-eng`, `herdr`, `maintain-verification-skill`, `technical-writing`, and `unslop`. Skills under `~/.codex/skills/` and plugin bundles are outside this comparison.

## Setup output

The installed `/setup-matt-pocock-skills` itself needs no update. Its existing repository output needed the glossary migration:

- Renamed root `CONTEXT.md` to `GLOSSARY.md` without changing its contents.
- Updated `AGENTS.md`, both README files, and the architecture, onboarding, and future-flow links.
- Updated `docs/agents/domain.md` to the v1.3.0 seed, including `GLOSSARY-MAP.md` for future multiple-context layouts.
- Kept GitHub Issues, the five canonical triage labels, the local priority rules, and the verification pointer.

`docs/agents/issue-tracker.md` differs from the current GitHub seed only in punctuation. `docs/agents/triage-labels.md` adds this repository's priority policy and has different table spacing. Neither difference requires a workflow change or another setup run.

The release also graduates `implement-spec`, `pr`, and `retro` into Engineering and removes `resolving-merge-conflicts`. None was installed in the compared directories, so this update does not install or remove skills.

## Reproduce the comparison

```sh
git clone --depth 1 --branch v1.3.0 https://github.com/mattpocock/skills.git /tmp/matt-skills-v1.3.0
diff -ru /tmp/matt-skills-v1.3.0/skills/productivity/writing-for-agents packages/cli/skills/writing-for-agents
diff -ru /tmp/matt-skills-v1.3.0/skills/engineering/setup-matt-pocock-skills "$HOME/.agents/skills/setup-matt-pocock-skills"
diff -u /tmp/matt-skills-v1.3.0/skills/engineering/setup-matt-pocock-skills/domain.md docs/agents/domain.md
```

`diff` exits with status 1 when it finds differences. Global comparisons reflect the local installation on the date above.
