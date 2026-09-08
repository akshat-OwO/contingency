# Repository guidelines

## Tooling

- Use `nub` as the package manager and as the file/script runner.
- Run `nub exec turbo run quality` for read-only lint and formatting checks.
- Run `nub exec turbo run quality:fix` to apply safe lint and formatting fixes.

## Engineering principles

- Always prefer performance and reliability.
- Do not look for workarounds. Write scalable code that does not add regressions.
- Use Effect everywhere.
- Do not rely on remembered Effect APIs. Always inspect the source in `node_modules` for the installed Effect version before writing or changing Effect code.
- Use Effect atom for atomic state management.

## Ultracite standards

- Write accessible, performant, type-safe, and maintainable code with clear, explicit intent.
- Prefer `unknown` over `any`, type narrowing over assertions, `const` by default, specific imports, and early returns.
- Await promises, handle errors meaningfully, and remove production `console.log`, `debugger`, and `alert` statements.
- Keep functions focused, validate external input, avoid `eval()` and unsafe HTML, and do not commit focused or skipped tests.
- Follow the root Oxlint and Oxfmt output as the source of truth for mechanical style and correctness rules.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles map 1:1 to tracker labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Verification

End-to-end proof for user-visible work uses `verify-contingency`. During triage and in agent briefs, see `docs/agents/verification.md`.
