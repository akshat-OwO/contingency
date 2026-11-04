# Implemented performance changes

This report covers the scoped runtime implementation following the [performance audit](performance-audit-2026-11-04.md).

## Behavior

- Workspace network lists project row metadata before transport. Headers, post data and bodies remain available through request detail inspection. Failed detail retrieval displays an alert; closing and reselecting retries the fetch.
- One projection function defaults Run session results to compact while preserving explicit full views and history paging. Teaching retains full defaults, including recording identity and instruction text. Cursor waits always return compact state, including when full is requested.
- Session state subscriptions use a capacity-one sliding queue per subscriber and selected session. Session Event observation and footage marking happen before coalescing. Cursor Session Events keep their separate reliable log. Workspace session and browser RPC client buffers each have capacity one and backpressure when full.
- Execution values have one scoped expiry worker and scoped registry disposal. Idle expired entries release without a subsequent read or insertion. Reads look up one entry and check its expiry without copying or pruning the map.
- Interpreter stderr drains completely while retaining at most 64 KiB of raw bytes and at most 64 KiB of decoded UTF-8 output. Crash diagnostics show the final 500 characters. Split UTF-8 characters reconstruct across chunks; malformed bytes cannot expand the returned string beyond the cap.

## Transport boundary

The live JSON and binary routes use Effect 4.0.1's default WebSocket protocol. `RpcServer.makeProtocolWebsocket` delegates to `makeSocketProtocol`, which writes encoded responses to `socket.writer`. The server `streamBufferSize` option applies to the separate HTTP POST protocol through `makeProtocolWithHttpEffect`. It does not bound these WebSocket writers. Ineffective server options were removed.

The actual new bounds are the sliding subscriber queue and the capacity-one Workspace client buffers. There was no server queue of 16 on these WebSocket routes and this implementation does not add a server queue of one. Socket pending-byte limits remain follow-up work. Bounded message counts do not establish bounded snapshot bytes or whole-process memory.

## Matched production measurements

The same isolated production proof ran on original HEAD runtime source and candidate runtime source. Temporary source restoration was protected against concurrent edits. Both used 21 browser actions and two network records. One fixture request carries a 4 KiB padding header. This deliberately exercises header-heavy traffic; it is not a production traffic distribution.

| Serialized result      |    Original | Candidate final-8 |
| ---------------------- | ----------: | ----------------: |
| Default Run session    | 5,757 bytes |       1,446 bytes |
| Explicit full session  | 5,757 bytes |       5,757 bytes |
| Workspace network list | 5,851 bytes |         593 bytes |

Values exclude protocol envelopes and compression. These establish fixture payload reductions, not FPS, latency, CPU, throughput or aggregate RSS improvements. Earlier final-3 measured full 5,756 and network 593; final-4 measured full 5,757 and network 592. Numeric metadata widths explain these small differences; the full-result difference is the digit width of `ownerProcessId`, not a schema change.

Evidence is under `.cursor/skills/verify-contingency/artifacts/`. The matched baseline is `devtools-observe-baseline/`; final-8 is `devtools-observe-candidate-final-8/`. Production proof opens request headers and response text after list projection, checks console errors and HAR, and exercises Teaching recording identity, instruction readback, listing, mutation responses and compact cursor waits.

## Verification

Logs below are under `performance-implementation/` and record the test arguments and observed exit status.

- `bounds-services.log`: 69 passing tests across agent-session, code-interpreter, execution-values and session-state-changes. The stalled-viewer regression checks reliable events alongside coalesced snapshots. The 10,000-publication test checks capacity, isolation and subscriber disposal. Expiry and teardown use TestClock and retained counters. Real noisy children test draining, retention and final crash diagnostics.
- `bounds-integration.log`: six passing MCP efficiency/history, Teaching and browser-streaming tests.
- `recovery-tests.log`: six passing DevTools component tests, including failed-detail display and successful close/reselect recovery, with the real virtualizer and RPC dependency injection.
- `corrected-quality-types.log`: six successful quality/type tasks after removal of ineffective server options. Cache hits are source-keyed; this log identifies the tasks that ran.
- `candidate-final-8-journal.json`: build, launch, doctor, fixture, MCP, proof and cleanup all exited zero. `candidate-final-8-process-check.json` records actual ps/lsof commands confirming all owned PIDs absent, all five ports closed, and isolated state removed. The earlier final-6 cleanup had an ENOTEMPTY error and succeeded on retry, with its separate process checks retained.

`baseline-stream-regression.log` is a restored-source run: original HEAD runtime with candidate regression tests, then candidate source restored. It fails with stale Takeover rather than final Closed. `stderr-red-before-fix.log` is explicitly a historical transcript excerpt, not a new baseline run. The saved green tests rerun the actual child-process regression.

## Limits and follow-up

The structured integration helper requests full results to preserve existing history assertions. Dedicated agent-format tests and production proof exercise real defaults. Failed-detail recovery has component coverage; the production drive checks successful detail inspection without injecting an RPC failure. `stalled-rpc-tests.log` covers the complete real JSON and binary RPC transport: a separately scoped client stalls at its first decoded snapshot, then interruption closes its client scope and the server source finalizer completes. This proves cancellation/release; it does not measure socket pending bytes under load.

The inherited one-second crash-drain join remains, but a missed deadline now explicitly returns "Diagnostics incomplete" instead of silently substituting empty text. No dropped-byte telemetry was added. Receipt storage, closed-session retirement, server-side discovery, console separation, socket pending-byte limits and native codecs remain audit follow-ups. This implementation does not claim all audit opportunities are complete.

The final-6 production run repeats the same 21 actions and two network rows after removing ineffective server options. Its exact values are default 1446, full 5757, and network list 593 bytes.

## Final transport and race coverage

Request-detail updates carry a selection token and check the selected request identity. Late success, failure and loading completion from an older fetch cannot overwrite a new selection, including reselection of the same request. Unmount invalidates the token. `bound-ui-tests.log` records seven passing component tests on current source hashes, including a held old fetch failing after newer successful recovery.

`complete-services.log` records the latest 71 passing service tests, including deterministic TestClock deadline and stream-failure diagnostics. `stalled-rpc-tests.log` records two passing real loopback cases, JSON and binary. The broader six-test integration run remains in `bounds-integration.log`. `complete-quality-types.log` records final quality/types. `final-check-manifest.json` records commands, exit codes, process ownership/timestamps and source SHA-256 hashes for the UI, complete service run and quality/type checks. The complete runs hash both tracked changes and untracked source, including the subscription helper and its test. Vitest summary logs do not necessarily embed their commands; the manifest is the command and exit-status record for `bound-ui-tests.log`, `complete-services.log` and `complete-quality-types.log`. Earlier `diagnostics-services.log` is a 71-test summary without embedded arguments.

Final-8 exact metrics: {"historyEntries": 21, "networkListBytes": 593, "networkRows": 2, "phase": "candidate-final-8", "sessionDefaultBytes": 1446, "sessionFullBytes": 5757}.

Stderr stream errors now explicitly return "Diagnostics incomplete: stderr stream failed." The timeout and failure paths have deterministic service coverage; neither silently becomes an empty diagnostic. Final-8 production metrics: {"historyEntries": 21, "networkListBytes": 593, "networkRows": 2, "phase": "candidate-final-8", "sessionDefaultBytes": 1446, "sessionFullBytes": 5757}.

The current `complete-quality-types.log` belongs to manifest entry `release-quality-types-final`. Earlier entries named `complete-quality-types` and `complete-quality-types-final-report` refer to prior checks; use the named release entry for the final report hash, PID and timestamps.
