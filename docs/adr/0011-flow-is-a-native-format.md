# Flow is a native Contingency format

> Superseded by [ADR 0038](./0038-contingency-is-an-agent-sanity-monitor.md) for new work: this decision belongs to the removed deterministic Flow and Audit View stack. Supersedes [ADR 0001](./0001-flow-as-chrome-recorder-json.md).

A Flow is Contingency's own JSON document, no longer constrained to be Chrome DevTools Recorder–compatible. Chrome's action model admitted only `navigate`, `click`, `change`, and `keyDown`/`keyUp`, which left a tool that audits real sites unable to express hovering, scrolling, selecting an option, or waiting — and lazy-loaded content that is never scrolled to is invisible to an accessibility Audit. Chrome Recorder import is dropped entirely rather than kept as a converter.

## Considered Options

- **Playwright codegen** — rejected on inspection: codegen emits _source code_, and a Flow must stay _data_ so Create View can render it as an ordered Step list, insert an Audit Step at a chosen position ([ADR 0005](./0005-audits-are-ordered-custom-steps.md)), and let a Run map Findings back to individual Steps. Neither is possible against a `.ts` script without parsing and re-emitting a program.
- **Stay a Chrome superset, express new actions as `customStep`** — technically available, since `customStep` is Chrome's own extension point and Audits already use it. Rejected because a Flow whose interesting half is opaque `customStep` blobs carries the compatibility label without the compatibility.
- **Keep a one-way importer** — rejected under the no-backward-compatibility decision below. It was the one argument for retaining a Chrome selector parser.

## Consequences

- **v1 actions**: `navigate`, `click`, `change`, `keyDown`/`keyUp`, plus `hover`, `scroll`, `selectOption`, `waitFor`, and `press`. `assert` is deferred deliberately — it overlaps with Audits and Findings, and that boundary should be drawn on purpose rather than by accident. `setInputFiles` and `dragAndDrop` wait for a motivating case.
- **Selectors are an ordered array of structured locator descriptors.** Playwright's locator is single-strategy; Chrome Recorder's `selectors: string[][]` was an ordered list of alternatives. Contingency keeps the array and adopts Playwright's semantics inside it, because a product whose job is re-running a Flow against a drifting site months later needs fallback more than it needs a single canonical locator.
- **Record ladder**: `role`+accessible name → `label` → `placeholder` → `text` → `css` → `xpath`. Test-id is excluded: Contingency audits sites it does not own, so test IDs are usually absent and are the least meaningful strategy for accessibility work. Leading with role+name has a second payoff — when an Audit reports a missing accessible name, the selector degrades in a way that points at the same defect. XPath stays last because a positional path is the strategy that breaks first.
- **No backward compatibility.** Persisted Flows carrying `selectors: string[][]`, `target`, `frame`, or `assertedEvents` are not migrated. Contingency is pre-release with a single user; a migration path would cost more than re-recording. This retires the field-shape sniffing in `packages/protocol/src/flow.ts` rather than adding a third layer to it.
