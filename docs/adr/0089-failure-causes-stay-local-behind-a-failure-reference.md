---
status: proposed
---

# Failure causes stay local behind a Failure Reference

When a failure leaves Contingency today, it carries only a fixed `{ code, message }`. Each hop from a device, browser, or child process to MCP or RPC drops the cause, so a user's report can't be traced to what went wrong. The cause can't simply be passed along either. Child output and SDK errors may contain user data (`android-runtime-backend.ts`), and anything sent over MCP lands in model context and harness transcripts.

A failure whose cause the code doesn't fully state, meaning a defect or a runtime or child-process failure, now gets a **Failure Reference**. That is six random Crockford base32 characters, sent to the agent as `failureReference` and shown in the Workspace. Its cause is recorded against the reference in the process's **Diagnostic Log**. Validation errors and expected refusals, such as invalid parameters or a Domain Scope pause, already explain themselves and get no reference.

## Rules

- **An agent never receives a cause.** MCP results carry the code and the Failure Reference only, at any log level.
- **The Workspace may show the cause under debug.** When the terminal's log level is `debug` (`--debug` or the `log.level` Setting), the Workspace shows the cause in a collapsed detail beside the reference. The Workspace is the user's own local view; MCP is not.
- **The Diagnostic Log is safe to share as-is.** It never holds what a user typed, a Variable value, page text, header or cookie values, or screenshots. A user can attach it to an issue without reviewing it.
- **Safety is an allowlist, enforced by the logger.** A log message is a fixed string, which a lint rule enforces. Values that change are annotations, and the logger renders only safe kinds: codes and enum values, ids, counts, durations, hosts, platforms, Flow and Group names, and file paths relative to the Catalog Root or `~`. Anything else renders as `<redacted>`. URLs keep only their host. The terminal uses the same renderer, so `--debug` output is safe to paste as well. Spans exported over OTLP pass the same allowlist, and a failed span ends with its cause's shape, not its message.
- **A cause is logged by its shape.** The log keeps its tag, its chain of failure codes, and its stack frames. It drops free-text messages, except the fixed messages of Contingency's own typed errors. Child processes are logged by exit code, signal, duration, byte counts, and the error codes their wrappers recognize. The full cause and a bounded stderr tail stay in memory, keyed by Failure Reference, for as long as the process runs.
- **Nothing is swallowed silently.** `Effect.ignore` and equivalent recoveries name a log level, and a lint rule enforces it.

## Considered options

- **Send the cause to the agent.** Rejected: it would export user data into model context, which `android-runtime-backend.ts` already forbids.
- **Use the OpenTelemetry span id as the reference.** Rejected: 16 hex characters are too long to read out, and a span id exists only when tracing is exported.
- **Scrub known patterns from free-form log text.** Rejected: no scrubber can recognize a typed password, so a denylist can't guarantee a log is safe to share.
- **Give every outward failure a reference.** Rejected: self-explaining refusals would grow MCP payloads, against [ADR 0045](./0045-the-mcp-surface-is-sized-for-the-model.md), without helping anyone debug.
