# Repository guidelines

## Engineering

- Use `nub` for packages and scripts. Check with `nub exec turbo run quality`; apply safe fixes with `nub exec turbo run quality:fix`. Oxlint and Oxfmt define mechanical standards.
- Use Effect throughout and Effect atom for atomic state. Inspect the installed Effect source in `node_modules` before changing Effect code.
- Own the result: define observable acceptance criteria, inspect the owning module and callers, and read relevant `GLOSSARY.md` terms and `docs/adr/` decisions.
- Fix causes in the owning module. Prefer performance, reliability, existing conventions, and reusable services. Preserve existing work and keep changes focused.
- Write accessible, type-safe code. Narrow `unknown`, validate external input, await promises, and handle errors. Keep credentials out of logs and evidence.

## Verification

- Read `docs/agents/testing.md` before writing or fixing tests or changing waits. Reproduce regressions; wait on events or virtual time. Passing lint alone does not establish correctness.
- Use `verify-contingency` for user-visible or MCP-visible changes. Verify acceptance criteria on the final revision; rerun affected paths after edits and disclose evidence gaps.
- Review the final diff and delegated work yourself. Completion includes required checks, regression review, and cleanup.
- For GitHub issues and triage, read `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`. For verification briefs, read `docs/agents/verification.md`.

## Processes and memory

- Track every resource you launch: owner, session ID or PID, start time, descendants, ports, and stop operation. Parents own delegates' cleanup too.
- Run one heavy build, suite, or device proof at a time by default. Check memory and swap before launch and during long runs; stop expansion when memory pressure rises.
- Stop owned resources when their purpose ends, including on failure or cancellation. Before yielding, verify processes exited, ports closed, and owned browsers and devices stopped.
- Preserve user-owned processes and the agent host. Verify ownership before signaling; avoid broad name-based kills. Report cleanup failures explicitly.
