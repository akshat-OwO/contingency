# Playwright is the in-process browser runtime

> Supersedes [ADR 0004](./0004-cli-owned-cdp-recorder-sidecar.md). Amends [ADR 0002](./0002-cli-is-the-sole-runner.md).

Contingency drives the browser through `playwright-core` as an in-process library, replacing the bundled `agent-browser` binary and the CDP sidecars that had grown around it. Every browser operation was a subprocess spawn parsing `--json` stdout, and ADR 0004 had already conceded that the binary's surface could not supply selectors, frame context, navigation events, input, user-agent changes, or Core Web Vitals — so `cdp-client`, `cdp-input`, `cdp-recorder`, `cdp-user-agent`, and `vitals-collector` reached past it into raw CDP anyway. Playwright collapses two transports into one and makes those sidecars first-class instead of smuggled.

## Considered Options

- **Swap one out-of-process browser tool for another** — keeps the spawn-per-command shape that is the actual defect.
- **Drive CDP directly, no wrapper** — tempting given `cdp-client.ts` already exists, but means rebuilding Playwright's frame, lifecycle, and actionability machinery, which is the genuinely hard part.
- **Strangler migration behind the existing `AgentBrowser` interface** — rejected: that 2260-line interface is shaped around subprocess-per-command, so preserving it as a seam preserves the design mistake. With no backward-compatibility obligation ([ADR 0011](./0011-flow-is-a-native-format.md)) and a single user, a single-branch replacement is cheaper than a seam nobody will keep.
- **Runner first, Create View second** — rejected as the worst option: it keeps two browser stacks alive simultaneously.

## Consequences

- **The recorder survives, its transport does not.** ADR 0004's injected isolated-world recorder remains — Contingency owns recording and emits data, not code — but frame discovery and init-script timing move to Playwright's `addInitScript` and frame API. Recorder messages stay untrusted, schema-validated, and size-bounded; closed shadow roots stay outside the recording boundary.
- **Create View's canvas keeps its acked frame protocol.** Playwright has no public screencast API — `recordVideo` writes a file, it does not stream — so the stream is rebuilt on `Page.startScreencast` through `context.newCDPSession()`. `BrowserStreamEvent` and `acknowledgeFrame` are unchanged, and CDP still never reaches the web UI.
- **The Runner and Create View now share one browser stack**, which ADR 0002 had deliberately left open ("until the Runner reuses the same browser stack deliberately"). This is that decision.
- **Distribution changes**: `npx playwright install chromium` replaces seven bundled platform binaries. `agent-browser` already downloaded Chromium on first use, so the install tax is not new, and a pinned Chromium build makes Regression comparison more reproducible than the user's own Chrome would.
- **Interrupt force-kill disappears.** `inFlightBrowserCommands` and the six-second SIGKILL exist only because each command was a child process; in-process Playwright registers no pids. This dissolves [issue #41](https://github.com/akshat-OwO/contingency/issues/41). [Issue #40](https://github.com/akshat-OwO/contingency/issues/40) — the interrupt handler's wording — is independent and still needs fixing.
- **Website permissions become expressible.** `grantPermissions`, `clearPermissions`, and `setGeolocation(null)` are the operations `agent-browser` lacked; see [ADR 0013](./0013-emulation-belongs-to-the-flow.md).
- **Secret values now live in Contingency's heap** rather than being passed as `--secret NAME` to a subprocess. Redaction stays at the Run-artifact boundary, but scrubbing secret values out of error messages and selector diagnostics becomes a hard requirement rather than a nicety — a diagnostic that echoes field contents would print a credential into a Run artifact.
- **Selector failures report every candidate.** The Runner kept only the last candidate's message and surfaced the browser tool's raw string, so a two-candidate failure showed one XPath dump and discarded the other half of the evidence. A failure now reports each candidate's strategy, what it looked for, and why it missed — absent, ambiguous, matched-but-invisible, matched-but-detached — plus the nearest matches actually present. Ambiguity and absence become distinguishable, which Playwright's strict mode supplies and the previous runtime could not.
