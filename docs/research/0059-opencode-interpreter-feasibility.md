# OpenCode interpreter feasibility (#459)

**Recommendation: proceed.** OpenCode's interpreter runs in a separate, resource-bounded process on Contingency's Effect version, now 4.0.1, and in the packed CLI. The server keeps dispatch, validation, authority, and receipts. The limitations below are conditions for #460, not blockers.

This report covers ADR 0059's feasibility work only. The prototype exposes four operations, not every capability, and makes no adoption claim.

## Candidate

| Item | Value |
| --- | --- |
| Package | `@opencode/codemode@2.0.27` |
| Integrity | `sha512-Z+L/AQxVIx0umuqVjmNLYpfR64NNzw7eJ2dlpfdb3/jOsOD60lhPq+u6NxN5HRQig2IKJZ17x6LxA1EsHNHVOA==` |
| Upstream revision | tag `v2.0.27`, commit `1f4d07a4a519185955ae8ab2ea3607805509e386` in `anomalyco/opencode`, `packages/codemode` |
| Published | 2026-10-12T04:14:49Z |
| Declared dependencies | `acorn@8.15.0`, `effect@4.0.1` |

The package was renamed. `@opencode-ai/codemode@1.18.4`, the newest release under the old name, does not load on Effect 4.0.0: it imports `effect/unstable/http`, which stable Effect moved to `effect/http`. Every `2.0.x` release before `2.0.27` depends on an Effect release candidate. `2.0.27` is the first release built on stable Effect.

### Dependency compatibility

`2.0.27` pins `effect@4.0.1`. This change moves the workspace's Effect catalog and the CLI's direct pins from 4.0.0 to 4.0.1, so the interpreter and the server share one installed Effect with no override. The lockfile changes only Effect, its four `@effect/*` packages, the interpreter, and `acorn@8.15.0`. On 4.0.1 the CLI (489), release (32), and web (265) unit suites, every type check, and the packed install check pass.

Upstream's own suite also passes on Effect 4.0.0 at the pinned revision: 1398 of 1398 tests in 34 files (`bun test`, Bun 1.4.2).

### Reproducible acquisition

```sh
# The package. The project .npmrc exempts exactly this version from nub's
# 24-hour release-age gate, which would otherwise refuse it until
# 2026-10-13T04:14Z:
#   minimumReleaseAgeExclude=@opencode/codemode@2.0.27
nub add -D -E @opencode/codemode@2.0.27 --cwd packages/cli
nub ci

# Upstream's suite at the pinned revision, on stable Effect.
git init upstream && cd upstream
git remote add origin https://github.com/anomalyco/opencode.git
git sparse-checkout set packages/codemode
git fetch --depth 1 --filter=blob:none origin 1f4d07a4a519185955ae8ab2ea3607805509e386
git checkout FETCH_HEAD
cp -R packages/codemode ../codemode-compat && cd ../codemode-compat
# Replace package.json with: dependencies acorn@8.15.0 and effect@4.0.0,
# devDependency @types/bun@1.4.0. Then:
npm install --ignore-scripts && bun test
```

## Supported release environments

The release contract publishes one package, `@contingencyhq/cli`, for Node `>=24` (`engines`). CI and the release workflow build, pack, and verify that tarball on `ubuntu-latest` only. No workflow tests macOS or Windows.

| Environment | Status | Evidence |
| --- | --- | --- |
| macOS arm64, Node 24.16.0 | Verified | Unit and route suites, packed clean install, evidence script, end-to-end drive |
| Linux x64, Node 24 (`ubuntu-latest`) | Verified by CI | `verify-cli-artifact` runs the extended packed check on every PR |
| Windows | **Unsupported, unverified** | No release check runs there. Process-group termination uses `taskkill` in Effect's spawner, and the watchdog's parent check relies on `process.ppid`; neither was exercised. |

The packed check (`packages/release/src/verify-cli-install.ts`) installs the tarball offline into an empty directory. It then runs one interpreter program that dispatches `agent_sessions_get`, and one that must stop at the heap ceiling. Locally:

```text
Packed MCP stdio initialize, QuickJS execution, and interpreter process passed.
Clean packed CLI install passed: contingency v0.0.1
```

## Architecture

```text
MCP client ── agent_code_execute ──▶ server (contingency mcp)
                                        │ owns: operation list, strict decode,
                                        │ Domain Scope, Confirmation, ledger
                         stdin  NDJSON  │  stdout NDJSON        fd 3 NDJSON
                     ┌──────────────────▼──────────────────────────────┐
                     │ interpreter process (one per execution)          │
                     │  main thread: @opencode/codemode                 │
                     │  watchdog thread: RSS ceiling, orphan detection  │
                     └──────────────────────────────────────────────────┘
```

- `src/services/code-interpreter-process.ts` is the process entry, built to `dist/code-interpreter-process.js`.
- `src/services/code-interpreter.ts` spawns the process, enforces limits, validates messages, and records receipts.
- `src/services/code-interpreter-protocol.ts` defines every message as an Effect Schema.
- `src/services/mcp-code-interpreter.ts` registers `agent_code_execute` when `CONTINGENCY_MCP_CODE_INTERPRETER=true`.

## Results

Numbers come from `packages/cli/benchmarks/code-interpreter-feasibility.ts` against the built entry on macOS arm64. They and the end-to-end drive were recorded on Effect 4.0.0, before the upgrade; the test suites that assert the same outcomes pass on 4.0.1. Rerun it with `nub run build && node benchmarks/code-interpreter-feasibility.ts --long-wait` from `packages/cli`.

### Memory

Three quantities differ, and the prototype reports each separately:

- **Interpreter heap limit: none.** OpenCode exposes time, tool-call, and output limits. Its only memory bounds are per value: 16,777,216 string characters and 10,000,000 array elements per built-in call.
- **Process limits: two, both enforced by Contingency.**
  - A V8 heap ceiling of 96 MiB old space plus three 2 MiB semi-spaces (`--max-old-space-size`, `--max-semi-space-size`). V8 reports `heap_size_limit` as 106,954,752 bytes. Exceeding it aborts the process.
  - A 320 MiB resident-memory ceiling. A watchdog thread samples `process.memoryUsage.rss()` every 5 ms and kills the process when it is exceeded. The heap ceiling does not cover this memory: the interpreter exposes `Uint8Array`, whose storage lives outside the V8 heap.
- **Observed memory.** The watchdog reports samples on fd 3, and the program's final report includes its own usage.

| Scenario | Ceiling | Outcome | Observed |
| --- | --- | --- | --- |
| 40 × `new Array(1e6).fill(i)` | default | `memory_limit`, SIGABRT, 694 ms | peak RSS 190 MiB |
| Same program | heap 4 GiB, RSS 8 GiB | `completed`, value 40 | heap used 415 MiB, peak RSS 1108 MiB |
| 200 × `new Uint8Array(9e6).fill(1)` | default | `memory_limit`, SIGKILL, 95 ms | peak RSS 340 MiB |
| 60 × `new Uint8Array(9e6).fill(1)` | RSS 8 GiB | `completed`, value 60 | ArrayBuffers 515 MiB, heap 9 MiB, RSS 600 MiB |

The control rows run the same program across the same process boundary under the same 16,384-byte output limit. They complete with several times the ceiling in use. Neither isolation nor output truncation bounds memory; the ceilings do. Under the 67 MiB heap ceiling alone, 540 MB of typed arrays allocated without failure.

The RSS ceiling is sampled, not kernel-enforced. Observed overshoot was 17–20 MiB. A cgroup would make it exact on Linux but is unavailable on macOS.

### Termination

- **Unresponsive program.** `/^(a+)+$/.test("a".repeat(40) + "b")` holds the interpreter thread inside one native call. OpenCode's own timeout cannot fire there. In a probe it ran 21 s past a 2 s interpreter timeout. The server kills the process group at the program budget plus 1 s grace: `deadline_exceeded` after 3063 ms for a 2 s budget, exit SIGKILL.
- **Busy loop.** `while (true) {}` yields between interpreter steps, so OpenCode's timeout stops it: `program_failed`, `TimeoutExceeded`, clean exit.
- **Cancellation.** Interrupting an execution while an operation is in flight kills the process before the interruption returns (test `kills the process when its execution is cancelled`).
- **Crash.** A process that exits mid-program reports `crashed` with its exit code and no receipts.
- **Parent shutdown.** Scope close kills the process group on every path. If the server itself is SIGKILLed while the interpreter is blocked, the watchdog sees its parent change, reports `{"type":"orphaned"}` on fd 3, and kills the process. In the manual drive it was gone 19 ms after its parent died. If the interpreter is not blocked, stdin closing ends it.

No interpreter process outlived any test, benchmark, or drive. `pgrep -f code-interpreter-process` was empty after cleanup.

### Fresh state

Each execution is a new process. Three consecutive executions had three process ids; a variable defined in the first was a `ReferenceError` in the second. A server-held counter advanced across them. In the drive, `typeof snap` was `"undefined"` after earlier programs defined `snap`, while the same Run's Pending Decision state remained readable.

### Process boundary validation

- Both directions decode strictly; excess properties are refused. A `ready` message carrying an extra property ends the execution as `protocol_violation`.
- The server rejects a request for an operation it never offered and does not dispatch it. The rejection becomes a `rejected` receipt.
- OpenCode treats JSON Schema tool inputs as render-only. The prototype relies on that: every input is decoded again by the native tool's strict handler. `agent_sessions_get({ view: "compact", widen: true })` passes the interpreter and is refused by the server with a `failed` receipt naming `widen`.
- A program that calls an unoffered tool fails inside the interpreter with `UnknownTool` before anything reaches the server.

### Long Session Event waits

`agent_code_execute` accepts budgets from 1 s to 120 s, against `agent_code_run`'s 15 s. In the drive, `agent_session_get` with `waitMs: 45000` waited 45,008 ms inside a program and returned normally.

### Cost of the boundary

| Measure | Value |
| --- | --- |
| Process start to `ready` | 59–65 ms |
| One-operation program, end to end | 77–84 ms |
| Baseline RSS per execution | 82 MiB |
| Bytes to the interpreter, 4 offered operations | 8,183 for a search-only program |
| Bytes from the interpreter, one snapshot | 1,297 for a three-call program |

Most of the inbound bytes are operation signatures, resent to every fresh process. `agent_browser_act` alone renders a 1,623-character signature. At every capability this cost grows with the catalog. These are payload bytes, not model tokens; #461 measures context use.

## End-to-end proof

Driven through `verify-contingency` on an isolated instance (`launch`, `ecommerce start`, `CONTINGENCY_MCP_CODE_INTERPRETER=true mcp start`), with a task Run `Add one Giant anvil to the cart` on the shop fixture. Artifacts are under `artifacts/interpreter-feasibility/` and are not committed.

1. **Signature search.** One execution returned the four paths with no operation dispatched.
2. **Long wait.** `agent_session_get` with `afterCursor` and `waitMs: 45000` returned after 45,008 ms; the execution completed in 45,087 ms.
3. **Action, then termination.** A program read a Snapshot, clicked `Add Giant anvil to cart` with operation id `interp-add-1`, then blocked. The server killed it at its 6 s deadline. The result was `deadline_exceeded` with receipts for the Snapshot and the action. The process id no longer existed. The session timeline held one completed attempt, `action-991d1dca-…`.
4. **Retry the same identity.** A new program sent `interp-add-1` again with the same action. The server replayed attempt `action-991d1dca-…` without dispatching. The Page still read `1 item in cart` and the timeline still had one attempt.
5. **Intervention.** A program sent an irreversible click (`interp-add-2`) followed by a second click (`interp-add-3`). The first returned a Confirmation; the execution ended as `intervention` with that Pending Decision and two receipts. `interp-add-3` was never dispatched. Workspace showed `Confirm this action` with `Allow` and `Refuse` (ARIA and screenshot captured).
6. **Resolution.** `Refuse` in Workspace resolved it; `decisionHistory` records `refuse` from `workspace`, and no Pending Decision remains.
7. **Cleanup.** `control-contingency cleanup` stopped every owned process.

## Proposed runtime contract

For #460 to adopt:

1. One interpreter process per execution, spawned with `--max-old-space-size`, `--max-semi-space-size`, and `--disallow-code-generation-from-strings`, with an empty environment, in its own process group.
2. The server kills the process group at the program budget plus a fixed grace, whether or not the interpreter responds. Budgets range from 1 s to 120 s.
3. A watchdog thread in the process enforces a resident-memory ceiling and ends the process when its parent changes.
4. NDJSON on stdin and stdout, watchdog telemetry on fd 3, raw diagnostics on stderr. Every message decodes strictly on receipt.
5. The interpreter only requests operations. The server decides whether each operation exists and passes its input to the same strict handler an MCP call reaches. Each request leaves one receipt: `succeeded`, `failed`, or `rejected`.
6. A dispatched result that opens a Pending Decision ends the program. The server answers no later request and returns the decision with the receipts so far.
7. A crash, kill, or deadline never replays anything. Operation ids replay only when an agent sends them again, through the existing ledger.
8. The result reports its status, receipts, and process facts: exit, heap limit, peak RSS, startup, duration, and bytes each way.

## Limitations and conditions for #460

- **Windows** is unsupported and unverified. Either add a Windows release check or exclude the interface there.
- **The RSS ceiling is sampled.** Expect overshoot of tens of MiB. A hard limit needs a Linux cgroup or an upstream allocation budget.
- **Signatures cross the boundary on every execution.** For the full catalog, the process should ask the server for signatures on `search` instead of receiving them all up front.
- **Startup cost** is about 60 ms and 82 MiB per execution. A warm pool would conflict with fresh state unless each process still runs only one program.
- **Release age.** The `.npmrc` exemption names one exact version. Remove it once `2.0.27` is older than the gate, and never widen it to a range.
- **Upstream drift.** `2.0.27` pins an exact Effect version. Each Effect upgrade must move with an interpreter release on the same version.
