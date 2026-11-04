# Performance opportunities in Contingency

Audit date: 2026-11-04. Source revision: `b92a4b96e60390f5e43c9d1ceea18284a1bbe7b4`.

Start with session state retention and producer-side result sizes. The browser frame pipeline already drops superseded frames, and its optional binary codec already reduces representation overhead. The remaining opportunities span state fanout, replay receipts, long-lived records, discovery, DevTools allocations, and native streaming reliability.

This is an optimization audit and implementation plan. It does not implement runtime changes or establish measured speedups. Confidence below describes source evidence, not benefit magnitude. Priority is provisional until the first profiling pass.

## Evidence and limits

The audit follows `AGENTS.md`, `GLOSSARY.md`, `docs/agents/testing.md`, browser streaming architecture, and ADRs 0032, 0040, 0045, 0055, 0059, and 0072. ADR 0072 supersedes native MCP registration. Changes must preserve operation-id replay, user decisions, Takeover, capture independence, and verified Teaching cleanup.

Current-checkout evidence:

- A read-only schema census imported the real tool definitions with Node 24.22.2 using `vpx`. The base catalog has 42 operations. Its offered name, description, and input-schema records encode to 81,166 UTF-8 bytes. Records containing each name and an empty `description` encode to 2,108 bytes. Optional onboarding and Pursuit add 829 and 1,872 bytes respectively. These are discovery initialization records, not the emitted MCP `tools/list` response or model tokens.
- The sole code tool's offered-record array, containing its name, description, input schema, and JSON punctuation, encodes to 1,325 bytes. Its output schema and MCP envelope are excluded. The current catalog test caps the whole emitted tool list at 12,000 bytes. The old 81,000-byte catalog budget in ADR 0045 is historical.
- A schema-validated synthetic Run session containing 200 short timeline entries encodes to 29,658 bytes in full view and 585 bytes in compact view. This fixture is structurally valid but has `run: null` and no open authority state. This is an illustrative representation comparison. It is not a measured production distribution, transport benchmark, or evidence that every real session shrinks by that ratio.
- Existing execution-value, ledger, and DevTools service suites passed: 3 files, 13 tests, with one worker. They establish existing contracts, not the performance of proposed fixes.
- Historical browser benchmark results report about 25% fewer wire bytes but about 72% greater combined Node client/server CPU for Schema Binary. Those results exclude Chromium and ffmpeg CPU and were not rerun for this audit.

[Census results](./performance-audit-2026-11-04/census.json) and [census source](./performance-audit-2026-11-04/census.ts.txt) preserve the measurement. Reproduce from the repository root by copying the source to `packages/cli/node_modules/.contingency-performance-audit.ts`, running `vpx packages/cli/node_modules/.contingency-performance-audit.ts`, then removing the temporary script. This location resolves the installed package dependencies without changing source. The embedded revision identifies the audited checkout; update it when measuring a new revision.

The censuses were rerun with per-command timestamps, PIDs, exit codes, script and stdout digests in `census-runs.json`. Raw outputs are retained as `*.stdout.log`; zero-length stderr files show no diagnostic output for those runs. Raw verification output is preserved in the evidence directory as `service-tests.log` and `quality.log`; `verification.json` records command times, owning PIDs, exits, and script digests. The isolated retention probe below samples actual module heap but does not take heap snapshots. No full user journeys, live devices, tokenizer measurements, browser matrix, or throttled-network captures were run. There are no current-checkout bandwidth, latency, CPU, or RSS improvement claims. Host swap was already in use, so no heavy benchmark matrix was launched alongside the research agents.

A second [output census](./performance-audit-2026-11-04/output-census.json), with [reproduction source](./performance-audit-2026-11-04/output-census.ts.txt), populates Run details from the existing task-run fixture. It adds 200 attempts, 50 resolved decisions, one open confirmation, a Takeover, 100 Browser Snapshot nodes, and a 3,714-byte Flow document. The sizes below are synthetic service values, before interpreter receipts, MCP envelopes, or transport compression. They are coverage fixtures, not captured operation executions.

| Operation-shaped fixture | Requested view/state | UTF-8 JSON bytes |
| --- | --- | --: |
| Run start | Full, including document and first-call Workspace guidance | 46,448 |
| Run start | Compact, preserving document and guidance | 6,119 |
| Session get | Full, populated Run and history | 42,192 |
| Session get | Compact, same Run and history | 1,863 |
| Session cursor wait | Compact, Takeover and one event | 2,064 |
| Decision resolution input state | Compact with open confirmation | 2,238 |
| Decision resolution output state | Compact after resolution | 1,863 |
| Browser action | Full text, 100 controls | 3,315 |
| Action sequence | Two attempts, partial stop at confirmation | 3,825 |
| Run completion | Existing summary fixture with one attempt | 1,749 |

The full timeline and resolved-decision arrays account for 40,162 bytes in that populated fixture. Run details are 1,537 bytes; document delivery is 3,910 bytes including its wrapper, and Workspace guidance is 330 bytes including its wrapper. Component totals have separate JSON delimiters and must not be summed as if they were disjoint heap allocations. The output census also compares 500 synthetic network rows with a 4-KiB request header and a 1-KiB response header: 2,693,501 bytes in full versus 105,001 with row-only metadata. No claim is made about real header sizes or request distributions.

A hypothetical 100-KiB final program JSON value still costs about 100 KiB if the agent follows its resource link in full. A 16-KiB inline limit changes where the value is delivered, not total context cost when all of it is read. Measure resource metadata, full or selective reads, and follow-up turns in the actual journey. A resource link cannot by itself establish lower total tokens.

Reproduce the second census by copying its source to `packages/cli/node_modules/.contingency-output-census.ts`, running `vpx packages/cli/node_modules/.contingency-output-census.ts`, and removing that temporary script. [Provenance](./performance-audit-2026-11-04/provenance.json) records HEAD, dirty state, lockfile digest, commands, and current limits. The first census ran before this report was written; the provenance snapshot was captured afterward and explicitly records that timing difference. The historical streaming procedure and its artifact locations are documented in [browser-streaming-benchmark.md](../architecture/browser-streaming-benchmark.md); historical artifacts were not regenerated or independently revalidated here.

## Isolated module retention observations

A small [retention probe](./performance-audit-2026-11-04/retention-probe.json), with [source](./performance-audit-2026-11-04/retention-probe.ts.txt), ran with `vpx --expose-gc` against the real `makeSessionOperationLedger` and installed Effect PubSub. It created 5,000 unique synthetic session receipts, each with one roughly 1-KiB description and shared base fields. It did not create browsers, real sessions, actions, transports, or devices.

| Probe point            | Heap used after forced GC, bytes |  RSS, bytes |
| ---------------------- | -------------------------------: | ----------: |
| Before insertion       |                       31,251,480 | 136,626,176 |
| After 100 receipts     |                       31,618,336 | 137,166,848 |
| After 1,000 receipts   |                       34,609,848 | 140,722,176 |
| After 5,000 receipts   |                       47,501,136 | 164,020,224 |
| After `releaseSession` |                       47,475,936 | 164,184,064 |

All 5,000 operation IDs returned a replay tag after release. The probe checks replay availability, not exact snapshot identity or content equality; the ledger source returns the stored result. The probe prints its observations and does not assert those outcomes as a regression test. Changing input for an old ID returned conflict. Direct `rememberSession` does not populate `sessionOperations`, so this probe invokes `releaseSession` with an empty operation index. It does not exercise registered-action continuation cleanup. That path still requires a separate action/continuation fixture. The heap difference from the first to last sample was 16,224,456 bytes in this single process/run. The sample supports reachable receipt retention; it does not identify every heap dominator, predict a production per-operation cost, or establish a leak in the allocator. Existing process-lifetime replay is intentional. The optimization needs a different storage owner while preserving that behavior.

The same probe subscribed to installed unbounded and capacity-one sliding PubSubs without consuming them, then published 10,000 integers to each. The resulting sizes were 10,000 and one. This reproduces the queue mechanism used by the source owners, not a real RPC client backlog. Transport credits and encoding can change how much a live service accumulates, so a stalled-network proof remains required. Both PubSubs were shut down in the scoped probe, and its process exited. No production state changed.

Reproduce by copying `retention-probe.ts.txt` to `packages/cli/node_modules/.contingency-retention-probe.ts`, running `vpx --expose-gc packages/cli/node_modules/.contingency-retention-probe.ts`, then removing that temporary script. Memory numbers vary between runs. The unbounded/sliding counts and exact-replay outcomes are the stable observations; the byte samples are a diagnostic baseline, not a correctness test or savings claim.

## Proposed delivery order

| Order | Owning module and change | Benefit to establish | Effort | Main risk |
| --- | --- | --- | --- | --- |
| 0 | Add byte, queue, and retention measurements | Locate dominant costs on real journeys | Small | Instrumentation overhead |
| 1 | Separate changes for execution-value expiry and Workspace network projection | Reduce stale data and repeated headers | Small | List/detail compatibility; TTL race |
| 2 | Bound console delivery; per-session latest-state fanout and Workspace projection | Bound slow Workspace subscriber retention | Medium | Lost lifecycle transitions |
| 3 | Compact agent results and narrow discovery | Reduce IPC and conversation data | Medium | Missing authority context; discovery compatibility |
| 4 | Design replay persistence, then closed-runtime retirement as separate changes | Bound growth across operations and sessions | Large | Duplicate effects or lost retry evidence |
| 5 | Bound DevTools allocation before materialization | Reduce transient peaks | Medium | Compressed or unknown response sizes |
| 6 | Bound interpreter/channel traffic and isolate iOS viewers | Reduce peaks and capture failures | Medium | Cancellation deadlock; incomplete evidence |
| 7 | Profile binary codec and adaptive viewing | Reduce frame cost where measured useful | Medium to large | CPU, fidelity, coordinate mapping |

These are ordered work packages, not additive savings estimates. Items overlap: coalescing reduces serialization and retained snapshots, while replay and session retirement can reference some of the same objects. Do not sum encoded bytes and call them heap savings.

## 1. Bound session state per subscriber

**Evidence.** `packages/cli/src/services/agent-session.ts:1972` observes Session Events and marks the footage controller before publishing the whole snapshot. `:7170` subscribes to the global bus and filters by session after dequeue. Both service construction paths use unbounded PubSubs at `:9445` and `:9480`. Teaching adds a 500 ms durable refresh at `:7186`. RPC exposes this stream at `packages/cli/src/routes/rpc.ts:412`.

**Opportunity.** A slow subscriber can retain historical full snapshots, including snapshots for other sessions before filtering. Replace viewer state delivery with a per-session capacity-one latest-state channel, seeded atomically with the initial state. Give each state a monotonic revision. Keep event observation and footage marking on every transition before viewer coalescing. Use full reconnect baselines first. Add patches only if full-state encoding remains a measured bottleneck.

**Acceptance.** Hold a reader behind a Deferred while making 10,000 updates across two sessions. Pending viewer state must remain at most one per subscribed session, with no cross-session backlog. On release, the final state must be current. Session Events must retain cursor and truncation semantics; Takeover footage boundaries must remain complete. Test subscribe/publish races and terminal closure. Measure encoded emission bytes, backlog high-water bytes, and heap retaining paths. High source confidence, likely high exposure, unmeasured magnitude.

## 2. Move full Run history out of the live array

**Evidence.** `agent-session.ts:1395` declares `runTimeline`; `:3359` appends every entry and `:4077` initializes it. The record is passed structurally to `run-lifecycle.ts:733`, which uses this array to build the complete Run Summary. The same append path writes durable JSONL at `agent-session.ts:3367`, and the public snapshot timeline is capped at 200 at `:3400`.

**Opportunity.** Make durable JSONL the source for full summary history, or spill the array in bounded chunks. The current JSONL append is conditional on both `artifactDirectory` and filesystem availability. Constructors and injected service configurations that lack either must retain complete history through a process-owned temporary spill service with scoped cleanup, or keep the existing in-memory path explicitly until such a service is available. They cannot silently fall back to a 200-entry summary. A missing storage dependency must not turn a successful Run into lost evidence. Do not delete the array without replacing its finalization reader. Long Runs have no wall-clock ceiling under ADR 0043, so per-action retention grows throughout a Run. Summary construction itself can still allocate the full history; streaming summary encoding or paged summaries are a separate contract change.

**Acceptance.** An action-heavy Run produces the same JSONL and complete summary timeline, including failed, interrupted, and duplicate-id updates, and keeps the last 200 public entries. Test partial-file recovery, append failure, finalization retry, and ordering when timestamps tie. Run the same parity cases with filesystem absent, artifactDirectory absent, and temporary-spill failure. Ensure graceful compatibility fallback preserves all entries and disclose when that fallback retains unbounded history; do not claim a universal memory bound before the fallback is replaced. Compare retained heap after 1,000 and 10,000 operations and peak allocation during finalization. This removes a live retention path only after the summary reader changes; ledger receipts and evidence sets remain other growth paths. High confidence, medium implementation cost.

## 3. Keep replay identity without retaining every full result in heap

**Evidence.** `packages/cli/src/services/session-operation-ledger.ts:72` explicitly promises service-lifetime replay with no eviction. Entries contain kept-alive atoms, request text, gates, and complete action/session/summary results at `:80` and `:147`. `releaseSession` at `:517` removes continuation references and an index, not the receipts or boundary bindings. Some request identity is duplicated in `actionInput` and receipt input.

**Opportunity.** Move large terminal results to a process-owned receipt store and keep a bounded byte cache. Keep request identity and spent markers authoritative. Indexes also need an eventual bound or a disk index; a bounded payload cache alone leaves O(operation count) metadata. Retire boundary bindings after their replay requirements are represented elsewhere. Preserve paused continuations in memory only while runnable.

**Acceptance.** After 10,000 operations and closure, heap payload cache stays within a specified byte budget. Old identical IDs still return the original result; changed inputs still conflict; cache misses never dispatch an action. Inject cancellation before dispatch, after dispatch, at receipt commit, and during disk-write failure. Define atomic receipt persistence, uncertain outcomes, disk failure refusal, and process-lifetime cleanup before implementation. Do not replace exact replay with LRU eviction that permits duplicate effects. Structural sharing means serialized result totals are not retained-heap totals. High source confidence; large correctness risk and unknown total savings.

## 4. Retire closed runtime records and event state

**Evidence.** `agent-session.ts:1390` defines substantial runtime records: capture, runtime, browser references, downloads, evidence sets, scope, footage, and finalization state. Close at `:6447` saves a closed snapshot and closes the scope, but does not remove or compact the session record. The only `sessions.delete(sessionId)` found is failed startup at `:3896`. `packages/cli/src/services/session-events.ts:225` keeps per-session atoms and previous snapshots in a map with no removal API. Each event list is capped at 256, but the number of sessions is not.

**Opportunity.** Split live runtime ownership from lightweight closed-session lookup. After successful persistence, release capture and runtime graphs and page closed history from durable artifacts. Keep retryable finalization state until its write succeeds. Give closed-session lookups, event cursors, ledger replay, and Workspace lists explicit retention contracts before choosing a count or TTL.

**Acceptance.** Repeatedly create and close sessions, including failed finalization and closed Teaching inspection. No closed record retains Page/BrowserContext, capture images, or live closures after its documented release boundary. Recent closed views, old operation replay, late Session Event reads, and restart recovery still behave as specified. Compare heap dominators and Node/Chromium process trees after 100 cycles. Scope closure alone does not prove JS graphs were released. High confidence in reachable records; exact graph sizes need heap evidence.

## 5. Physically reclaim execution values at expiry

**Evidence.** `packages/cli/src/services/execution-values.ts:12` limits entries to 32, total encoded text to 32 MiB, and TTL to 30 minutes. `:46` prunes only on insertion. `:95` denies an expired read without deleting the text. The registry is created in a sync layer without scoped disposal.

**Opportunity.** Use scoped expiration scheduled against the next deadline and dispose the registry with its owning layer. Prune on expired reads as well. This is bounded stale retention, not an unbounded leak. UTF-8 text bytes are not a heap or RSS ceiling.

**Acceptance.** With TestClock, fill values, advance beyond TTL without another insertion, and observe physical entry and byte counters become zero. Test exact expiry and layer teardown. No expired value becomes readable during a race. Distinguish collectible heap from allocator-retained RSS. High confidence, small change.

## 6. Make agent output compact at the producer

**Evidence.** `packages/cli/src/services/mcp-session-output.ts:25` defaults to full; `:98` applies compact only when requested. The interpreter receives an operation result before user code can return a selected field. Final resource conversion happens after JSON serialization at `mcp-code-interpreter.ts:695`. Compact/history views, text/diff Browser Snapshots, screenshot paths, sequences, and result resource links already exist.

**Opportunity.** Prefer compact explicitly in generated signatures, documentation, and examples now. Correct the `agent_session_get` description at `mcp-agent-session.ts:256`, which says compact even though only its cursor wait branch at `:629` unconditionally compacts. Plain reads still honor the full default at `:643`. Evaluate a versioned compact default after compatibility tests. Introduce bounded, validated read projections for heavy operations so unwanted data never crosses child IPC. Keep action receipts, current interventions, Pending Decisions, Takeover, newest outcome, and evidence links mandatory. Do not truncate JSON into a plausible partial value. Keep full/history available on demand. Promote explicit `format: "diff"` for actions with a valid whole-page baseline. Preserve full text on navigation or missing/partial baselines. Defaulting all actions to diff is a separate compatibility decision because unchanged controls then disappear from the latest response. Test reloads at the same URL and baseline expiry as well as URL changes.

**Acceptance.** Compare the same Teaching, Guided Run, Dry Run, interactive Run, decision pause/resume, and Takeover journeys with full and compact defaults. Record input/output UTF-8 bytes, target-tokenizer tokens, child IPC, resource follow-up calls, action count, and completion correctness. Agent must see every required intervention. A target of at least 50% less session-result traffic on history-heavy fixtures is a proposed gate, not an observed gain. No regression on short sessions. Medium practical-frequency confidence.

## 7. Search operation signatures on the server

**Evidence.** `mcp-code-interpreter.ts:667` uses `code.includes("search")` to send all operation input schemas/descriptions into every searching interpreter. `code-interpreter-process.ts:181` reconstructs every tool, with `output: {}`. A narrow query still initializes the whole offered catalog. The census measures 81,166 bytes versus 2,108 for records containing names and empty descriptions. Largest records are DevTools 9,445 bytes, device workspace 9,377, and Teaching instruction 8,138.

**Opportunity.** Cache rendered signatures beside the server's handler catalog. Fetch only requested matches and pages through discovery IPC. Keep fresh program state and authoritative server validation. Preserve `search` query, pagination, and discovery/execution separation. A substring heuristic also triggers on unrelated text containing search. Replace it with a semantic mechanism only when discovery compatibility is covered.

**Input and output schemas.** Discovery currently has input schemas but empty operation output definitions. Offer compact discriminated result summaries on request, including status, intervention, receipt, pagination, and resource-link shapes. Generate them from protocol owners and budget each response. Do not inline complete session unions or restore native registration. Split DevTools discovery by command family without proliferating top-level MCP tools or hiding correctness rules in descriptions that an agent never loads.

**Acceptance.** Golden discovery queries across browser, native, Teaching, Run, and optional Pursuit return equivalent callable names and strict parameter constraints. Narrow searches transfer only matching signatures plus a bounded index, with a proposed under-16-KiB discovery page budget. Measure real IPC, child startup, parent/child peak memory, invalid calls, extra discovery turns, and total journey tokens. Schema removal that causes repeated retries is a regression. High source confidence.

## 8. Bound DevTools bodies before full materialization

**Evidence.** `packages/cli/src/services/browser-devtools.ts:282` reads `response.body()` in full, `:304` converts it to text, and `boundedDevtoolsText` at `:28` allocates another Buffer before clipping to 65,536 bytes. HAR assembles up to 500 entries. `mcp-browser-devtools.ts:81` writes the assembled result as a file; returning a file path already prevents agent context bloat but does not prevent server peak allocation.

**Retained HAR results.** `browser-devtools.ts:381` replays `state.stopped.har`, and `:460` stores the complete decoded HAR there until another start or tab disposal. Streaming the export file alone does not release that object. Move completed HAR replay to a file-backed, exact result reference with a bounded cache, preserving same-stop-ID equality and write-failure retries. Test repeated start/stop, old and current stop IDs, file corruption/deletion, and tab close; do not retain an object plus its file and call the work complete.

**Opportunity.** Reject known oversized body reads before materialization, report explicit omitted/unknown/truncated states, and decode a bounded prefix. Playwright's full-body API cannot guarantee bounded reads for absent or misleading lengths or compressed expansion. Supporting arbitrary previews needs a bounded capture mechanism; a Content-Length check alone is not a complete fix. Stream HAR serialization and avoid another whole-document string. Keep Browser Check evaluation separate from UI preview policy.

**Acceptance.** Large, compressed, chunked, unknown-size, and UTF-8 fixtures return truthful omission metadata. Oversized preview requests must not invoke full body reads. Measure parent and Chromium peak RSS and protocol bytes, including a 500-entry HAR and concurrent detail requests. Body-dependent checks keep their evidence semantics. High confidence in allocation sequence; transient peak magnitude unmeasured.

## 9. Budget interpreter bytes before queues and copies

**Evidence.** `code-interpreter.ts:365` and `:380` create unbounded input and read queues. Stdout is split into lines before validation at `:405`. The child serializes completed values for a size check at `code-interpreter-process.ts:225`, serializes them into the protocol, and the parent serializes again for resource handling. Existing limits include 50 calls, 96 MiB V8 old space, 320 MiB child RSS, 1 MiB final result, 16 KiB inline result, watchdog, deadline, and scoped child termination. None is a parent aggregate-memory bound.

**Separate stderr path.** `code-interpreter.ts:439` collects all child stderr through `Stream.mkString`. The stdout line budget does not cover it. Production reachability is constrained by the sandbox, but interpreter startup errors, runtime crashes, and malformed-child tests can produce diagnostics. Use a 64-KiB UTF-8 tail ring with total/dropped byte counters, continue draining so the child cannot deadlock, and preserve enough tail for heap-exhaustion classification. Exercise this through the injected-command seam with a noisy/crashing child. Treat flood prevalence as unmeasured.

**Opportunity.** Add per-operation encoded result limits, a bounded protocol-line decoder, and shared in-flight byte accounting. Give cancellation/end messages a path that cannot deadlock behind data backpressure. Prefer file/resource references at heavy producers. Profile copies before switching codecs or pooling interpreters. Pooling risks violating fresh-program isolation and is deferred.

**Acceptance.** Oversized lines, logs, operation values, and blocked writes produce explicit overflow outcomes with bounded parent/child allocations. Completed effects retain valid receipts even if delivery fails. Cancellation exits the child and descendants and permits no later action. Add a process-wide concurrent-interpreter budget if concurrent clients demonstrate aggregate peaks. Queue flood reachability is not proven by merely finding `unbounded`. Medium confidence in practical backlog, high confidence in repeated encoding.

## 10. Bound reliable event and stdio delivery separately from viewer state

**Evidence.** `agent-session.ts:1719` has an unbounded Session Event batch PubSub. `create-browser.ts:348` has an unbounded control event PubSub with replay 32, and `:360` an unbounded download bus with replay 64. `mcp-channel.ts:64` has an unbounded shared stdout queue, although notifications coalesce by session and kind before enqueue.

**Opportunity.** Inventory each subscriber and delivery guarantee. For cursor-addressable events, send bounded wake hints and reread the event log, reporting truncation. Use pressure limits and explicit disconnection for slow diagnostic viewers. Downloads and decisions require reliable ownership; do not silently drop them. Prevent channel notifications from accumulating indefinitely behind a stalled host without blocking MCP replies or cancellation.

**Acceptance.** Stall each consumer with a Deferred and flood its producer. Memory stays within configured byte bounds; reconnect restores current state, cursor gaps report truncation, and downloads/decisions remain inspectable. No slow observer stalls capture or input. High topology confidence, subscriber-specific reachability still to measure.

## 11. Isolate iOS viewer overflow from capture

**Evidence.** `packages/cli/src/services/ios-stream.ts:527` ends a slow viewer queue, reports `capture_incomplete`, and kills the shared worker. Queue capacity is eight at `ios-stream.ts:552`. Android closes only the slow client at `android-stream.ts:237` and waits for a keyframe on reconnect. iOS is authenticated HTTP NDJSON at the bearer check in `routes/ios-stream.ts:47` and NDJSON response in `:58`, not WebSocket. Its helper emits JPEG packets, so do not assume Android H.264 delta rules apply to it.

**Opportunity.** Trace viewer and recording subscribers and isolate display overflow from evidence capture. Independent JPEG viewers may use newest-frame delivery if the envelope preserves orientation, generation, and timing. Recording/integrity overflow must remain strict and explicit. The shared worker's integrity path runs before viewer fanout, but full lifecycle proof remains necessary.

**Acceptance.** Stall one viewer while another viewer and Teaching capture run. Only the stalled viewer disconnects or skips superseded complete images. Worker and recording remain healthy; genuine recording gaps still fail. Verify reconnect, rotation, background/resume, and teardown on the supported simulator. No device proof was run. High confidence in kill path, conditional on lifecycle trace.

## 12. Profile frame transport before lowering fidelity

**Evidence.** `create-browser-screencast.ts:37` defaults to JPEG 90 and max pixel ratio two, decoding CDP base64 once. `create-browser.ts:351` already uses capacity-one frame publication with replay one. The UI stream uses buffer one and latest-pending decode, closes bitmaps, and limits diagnostics to 120 samples. `apps/web/src/lib/rpc.ts:43` exposes Schema Binary; JSON remains the default in `browser-stream-settings.ts:10`. Installed Effect 4.0.1 `src/rpc/RpcSerialization.ts:550` uses schema codecs and a framed envelope with a default 16 MiB frame limit.

**Opportunity.** Profile schema traversal, validation, envelope copies, and multi-viewer encoding. Compare a narrow binary image envelope only if it beats the existing binary codec on both CPU and wire cost at equivalent behavior. Base64 length is `4 * ceil(n / 3)` characters before envelope and transport compression, so eliminating it saves about a quarter of that representation, not a third of total traffic. Already-compressed JPEG is a poor default target for additional compression without CPU evidence.

Evaluate hidden-viewer pause and viewer-only FPS/resolution adaptation separately from Teaching capture quality. Preserve demand-driven capture and recorder independence. Frame coalescing, wheel coalescing, pointer bounds, and bitmap cleanup are already implemented and are not new recommendations.

**Acceptance.** Run `vpx packages/cli/benchmarks/browser-streaming.ts --check` and `vpx packages/cli/benchmarks/browser-scroll.ts --check` sequentially on a quiet host. Extend with multiple viewers and throttled links. Measure Node, Chromium, and encoder CPU separately; wire bytes by route/event; receipt-to-canvas p50/p95/p99; image quality; pointer/Inspect alignment; frame/decode depth; heap/external memory. Existing budgets are fast receipt p95 <=100 ms, slow <=400 ms, decode <=20 ms, JPEG-90 whole/text PSNR >=38/36 dB, and dynamic binary wire/image <=1.08. These are regression floors. New improvements must also beat a same-machine baseline in their target workload. Physical display latency and remote clock skew remain explicit limits.

## 13. Project the Workspace network list before polling it

**Evidence.** `apps/web/src/components/agent/workspace-browser-stage.tsx:533` runs `useBrowserSetup` on the two-second refresh clock. It reads emulation, tabs, and the active tab's network list even when the network panel is closed. `create-browser.ts:813` returns request metadata, which still contains header maps under `packages/protocol/src/index.ts:213`. `agent-session.ts:8111` runs `redactDevtoolsRequest`, which preserves headers. The list UI at `browser-devtools.tsx:697` needs row metadata; the separate detail call already fetches headers and body. The agent's own `filterDevtoolsRequests` path strips headers, so the missing projection is specifically the Workspace RPC.

**Opportunity.** Define a strict Workspace list schema with request ID, tab ID, method, URL, status, resource type, timestamp, duration, size, and fields the row actually reads. Fetch headers/post data only on detail selection. Poll network data only while needed, or use versioned invalidation and fetch since the last revision. Preserve the rail's request count while the panel is closed, perhaps through a cheap count/version field. Emulation and tab identity still need independent refresh; do not stop the entire setup clock when hiding the network panel.

**Acceptance.** A fixture with 500 requests and large Cookie/Authorization/response headers shows a smaller list payload on every unchanged poll without sending those maps. Detail selection still returns the intended local-user data. Verify row fields, clear, tab switching, dropped requests, recording attachments, and closed-panel count badges. Compare 30 seconds of RPC bytes with panel open/closed and retained UI heap. The active `useBrowserSetup` replaces the latest request array; it does not use the legacy 10,000-entry merge store. The projection reduces poll bytes and client copies. It does not free header maps retained in the server tab records; those need separate attribution and retention work. High confidence, small to medium change.

## 14. Keep console floods off the frame delivery path

**Evidence.** `create-browser-page.ts:27` publishes console/page-error events into `session.events`. `create-browser.ts:348` creates that unbounded bus and `:953` merges it with frames, pointers, and tabs into the same RPC subscription. Console entries at or below 8 KiB retain their text. Larger text is replaced completely with `[content omitted: size limit]` at `browser-devtools.ts:158`. Event rate remains unbounded. `agent-workspace.tsx:1414` appends these events through `agent-workspace-state.ts:83`, whose live console cap is already 500. The legacy DevTools store's 10,000 cap is not used here.

**Opportunity.** Use a separate bounded diagnostic stream with dropped-event counts and reconnect recovery from the server ring. Gate detailed console delivery on the panel where possible while retaining a cheap error count. Keep status, URL, tabs, bot-protection, and pointer events available with the correct ordering; they cannot share a drop policy with console text. A separate RPC stream can still use the same physical socket and compete for bytes. Evaluate scheduling or a separate connection if stream separation alone does not protect frame latency. Capture and diagnostic loss policy must remain independent.

**Acceptance.** Add a fixture that emits an 8-KiB line at 100 Hz alongside animation. Hold a reader with a Deferred. Diagnostic queue bytes remain bounded, dropped counts are truthful, console shows the newest retained errors, control changes arrive, and capture continues. Compare frame receipt/canvas latency, CPU, and wire bytes against the identical baseline. Passing the existing 100-ms fast receipt floor alone is insufficient; require improvement under the flood and no quiet-page regression. High source confidence; measured head-of-line impact remains unknown.

## 15. Publish a Workspace-specific session view

**Evidence.** The live stream currently returns the full shared session schema. Searches of the active web consumers found no reads of live `session.timeline` or `decisionHistory`. The UI does read Teaching instructions and Run findings, variables, scan results, and emulation provenance. Decision history appends at `agent-session.ts:5677`, `:8214`, and `:8554` without a 200-entry timeline cap. The live session stream at `apps/web/src/lib/rpc.ts:333` does not request the browser stream's explicit buffer size one.

**Opportunity.** Add a typed Workspace projection that omits unused history and preserves the fields the dock, details, pending decisions, and setup tools read. Do not reuse the agent compact view blindly: it deliberately reduces information the Workspace renders. Define the projection in the protocol and update consumer types. Compare projected values before encoding to avoid full republish for ignored-only changes. Keep full history behind history/summary reads. Combine with finding 1's per-session latest-state channel rather than building two competing publication mechanisms.

**Acceptance.** Over a 1,000-action Run with repeated decision resolution, projected bytes exclude historical timeline and decision arrays. All dock, Teaching, scan, provenance, takeover, boundary, verification, and summary flows remain correct. Agent history still pages every retained decision and Run Summary still contains every attempt. Test terminal transitions and reconnect from a full projected baseline. High confidence in omitted-field candidates, with final consumer audit required before implementation.

## 16. Remove base64 from native mirror packets when profiling justifies it

**Evidence.** `packages/cli/ios/framebuffer/framebuffer.m:145` produces JPEG frames with width ceiling 720, quality 0.65, and 30-fps pacing, then base64 JSON. `ios-stream.ts:194` publishes JSON packets, and `apps/web/src/components/agent/ios-workspace.tsx:119` decodes images while consuming the stream. `packages/cli/src/android-stream-worker.ts:148` base64-encodes H.264 packets; `android-stream.ts:29` serializes packets and the web decoder reverses base64. Both native routes are HTTP NDJSON rather than the browser WebSocket codec.

**Opportunity.** Evaluate length-prefixed binary image/access-unit packets over the authenticated HTTP streams. Preserve dimensions, orientation, generation, timing, and decoder configuration. Keep existing transport as a rollout fallback. JPEG frames can use latest-complete-image display semantics. Android H.264 requires configuration plus a keyframe; continue closing slow viewers until a reset-and-keyframe recovery path is proven. Reusing H.264 for iOS is a larger encoder/decoder project and is deferred, not a prerequisite to binary JPEG transport.

**Acceptance.** Same supported device and scripted motion, before/after wire bytes, CPU, decode depth, and process-tree RSS. Compare ten-second intervals with static, scroll, rotation, and stalled readers. Target elimination of base64 representation overhead, about 25% of that image representation before other framing, not a guaranteed total-wire saving. Native touch mapping, generation retirement, reconnect, integrity failures, and evidence capture must remain correct. Add a stream frame byte cap before allocation and test fragmented/malformed headers for the binary parser. Source confidence high; native runtime measurements absent.

## Transport topology and pressure ownership

The installed Effect sources matter here. `packages/cli/src/routes/rpc.ts:574` wires both browser routes through `RpcServer.layerHttp`. For WebSocket upgrades, installed `packages/cli/node_modules/effect/src/rpc/RpcServer.ts:1523` creates the socket protocol. It encodes before `writer.write` at `:1563`, advertises acknowledgements at `:1625`, and removes client registrations through a connection-scope finalizer. `streamEffect` creates a latch at `:410` and waits on it at `:433` and `:452` after each emitted chunk when acknowledgements are enabled.

Installed `effect/src/rpc/RpcClient.ts:457` creates a bounded queue, with the call default of 16 at `:348`; `:578` sends the acknowledgement after enqueue. This is a chunk/enqueue credit, not proof that an image was decoded or displayed. The browser frame call explicitly uses one; the live session call currently inherits 16. Emitted chunks may contain multiple values, so queue item counts are not byte ceilings.

| Route | Application producer | Protocol and writer | Client and cleanup |
| --- | --- | --- | --- |
| `/ws` browser subscription | Frame slot one plus independent console/control buses | JSON, RPC chunk acknowledgements, WebSocket writer | Explicit one-event RPC buffer, latest-pending canvas decode; viewer fiber scope interrupts on session switch/unmount |
| `/ws/browser` browser subscription | Same capture and buses | Schema Binary framed codec, same RPC credits/writer | Same viewer; reconnect retires old stream identity |
| `/ws` session subscription | Global unbounded snapshot bus plus durable refresh | JSON, RPC credits, same writer | Default queue 16, full snapshot adoption, connection retry |
| Native `/android/stream/*` and `/ios/stream/*` | Per-viewer bounded eight-packet queues | Authenticated HTTP NDJSON body, Node response writer waits for `drain` | Fetch reader and decoder; abort/cancel removes viewer; owner closes worker separately |

`@effect/platform-node/src/NodeHttpServer.ts:273` wraps Node `ws` upgrades with Effect's `Socket.fromWebSocket`. Installed `effect/src/socket/Socket.ts:1136` calls `ws.send` and returns without checking `bufferedAmount` or awaiting the Node send callback. RPC credits constrain each compliant stream's production, but other concurrent unary replies, stream chunks, and browser inbound buffers still need byte attribution. This is a missing byte ceiling, not proof of unlimited frame enqueue for a compliant single stream.

For native HTTP, installed `@effect/platform-node/src/NodeHttpServer.ts:648` calls `nodeResponse.write` and waits for `drain` when it returns false. This propagates pressure into the per-viewer queue, explaining why the queue's overflow policy matters. Kernel socket buffers and browser Fetch buffering remain outside those queue counts. HTTP cancellation closes the subscription scope; worker cleanup remains the session owner's responsibility.

Before changing transport, stall a real socket/HTTP reader with a controlled proxy or fixture, not just an application Deferred. Sample encoded bytes, acknowledgements, writer pending bytes, socket pending bytes, serialization frequency, HTTP writable length, client queue/decode depth, and aggregate memory. Stop or disconnect that owned peer and confirm subscriptions and ports close. Keep the precise existing frame bound claim limited to the application slot and UI decoder.

## Design gates and initial budgets

These numbers are proposed initial implementation limits, not measured current capacities or approved product changes. Before enforcement, run representative full/history/summary fixtures and require explicit large-result references or pagination for legitimate over-budget data. Retain exact retry results and never redispatch a mutation because delivery overflowed.

| Owner | Proposed starting budget | Pressure or expiry policy |
| --- | --- | --- |
| Per-session Workspace subscriber | One projected state plus one encoding in flight | Replace superseded waiting state; reliable events observed separately |
| Per-viewer console diagnostics | At most 128 entries and 512 KiB encoded, whichever first | Drop oldest diagnostics, report count; keep required control on its own delivery path |
| Per-process terminal receipt payload cache | 16 MiB encoded, at most 128 cached results | Disk-backed cache misses reconstruct exact results; metadata index accounted separately |
| Per-process receipt files and index | 256 MiB files, 4 MiB hot index | Preserve existing IDs; refuse admission of new mutating operations before dispatch at quota. Reads/retries and close/cancel remain available |
| Per-interpreter result frame | 4 MiB encoded maximum | Producer file/resource result for larger legitimate data; oversize delivery cannot erase committed receipt |
| Per-interpreter in-flight data | 8 MiB encoded with a 4-MiB maximum frame | Bounded writer/reader queues and byte reservations released on completion/cancellation |
| Per-process interpreter data | 32 MiB in flight, initially two active interpreters | Queue admission with cancellation; measure real concurrency before choosing final count |
| Interpreter control and diagnostics | 64 KiB control reserve plus separate 64-KiB stderr tail | Control bypasses data pressure, stderr drains continuously with dropped-byte count |
| Per-connection WebSocket pending data | 4 MiB candidate high-water mark | Pause disposable production or disconnect only this viewer; reconnect with baseline. Reliable mutation identity remains in server receipts |
| Discovery result page | 16 KiB encoded | Return cursor/offset and hasMore; single huge operation offers command-family detail pages |

Byte reservations are encoded-buffer budgets, not heap/RSS guarantees. Existing 16-MiB Schema Binary frame decoding and 1-MiB child final-result limits remain distinct. A maximum frame larger than the final program-result limit can be useful for an intermediate operation that user code reduces, but must fit parent and child memory. Oversized schema-valid output gets an explicit delivery error or reference, never malformed truncated JSON. Aggregate process admission must also account for the existing 320-MiB child RSS limit and native/browser workers.

Closed-runtime retirement needs a versioned contract before choosing eviction: propose keeping up to 16 lightweight closed snapshots for one hour, bounded additionally by 4 MiB, then returning a documented closed-session-expired response with Run/Recording references. Run artifacts remain in their existing durable stores. Old operation IDs retain service-lifetime exact replay independently. Closed event logs either remain disk-backed until service exit or return a documented expired-cursor conflict; there must be no silent cursor reuse. Do not enforce these new lookup semantics for existing clients without the protocol decision and compatibility proof. Failed finalization records remain retryable and cannot be evicted as if persistence succeeded.

Disk receipt design is a separate prerequisite to implementation. Store validated exact results in process-owned files, publish a checksum/versioned index only after an atomic temporary-write/rename, and preserve interruption-masked commit semantics. A pre-dispatch admission reserves disk capacity. Before implementing this, define a guaranteed small spent-marker reserve independent of payload quota. For an unknown-size result exceeding its reservation after dispatch, retain the exact full result in a bounded emergency owner or fail closed with its spent/uncertain identity, stop admitting new mutations, and require explicit recovery. No cache miss, quota overflow, or receipt-write failure may turn that ID into a new dispatch. Turn these transitions into a state machine and executable fault cases in the implementation brief. Failure before dispatch refuses safely; failure after dispatch retains an uncertain/spent marker and cannot retry the effect. Cover ENOSPC, partial/corrupt/missing files, concurrent retries, browser effect followed by write failure, and both normal and crash cleanup. Do not promise cross-process replay. Disk lifetime ends with this Agent Session service, and process-owned startup scavenging handles remnants after crashes. Disk offloading changes memory ownership; the 256-MiB quota and admission policy prevent replacing heap growth with unbounded disk growth.

Fanout ordering also needs a design gate. The session registry owns a monotonically increasing viewer revision under its mutation gate. A durable refresh captures the base revision before I/O; on completion it reconciles the current registry state and the durable store's identity/version, never blindly writing its older snapshot. If the revision changed during the read, retry or merge only authoritative durable fields after rereading. Durable-only changes obtain a new registry revision. Compare actual selected values or a stable content/version fingerprint, not `updatedAt` alone. Test equal timestamps, stale reads after a newer publish, discard/restart recording identities, close during refresh, and rapid reconnect. Atomic subscription registration and baseline seeding share the gate; remove subscriber state at zero subscribers and retire session channels only after terminal delivery policy completes. Session Event observation and footage marking remain upstream of all coalescing.

Result-shape discovery should extend the existing program `search` contract through optional bounded detail selection, rather than introduce a new top-level MCP tool. Proposed response fields are `name`, `schemaVersion`, `parameters`, `resultVariants`, `errors`, `pagination`, and `resourceKinds`. Summary variants explicitly name status/discriminants, intervention, partial-sequence stops, and receipts. A caller can execute by operation name without discovery exactly as today; validation remains server-side. Unknown schema versions fail explicitly or fall back to a documented known summary. Add golden consumer programs for ordinary success, refusal, confirmation/resume, partial sequence, Takeover, and resource-link results. Preserve first-call Workspace guidance, Flow document delivery, event cursors, and code-tool intervention wrappers in those programs. Mere input-schema equivalence does not prove that the agent understands results.

Land execution-value expiry independently from timeline persistence. Gate closed-runtime retirement on the new lookup/cursor contract. Gate replay offloading on persistence/fault proofs. Gate transport defaults on same-revision profiles. This ordering prevents a single broad refactor from hiding which change improved or broke a journey.

## Measurement and regression plan

First add opt-in bounded counters at the owning modules. Count bytes once for each representation: operation result before IPC, interpreter protocol in each direction, MCP result at emission, RPC stream at emission, and compressed/uncompressed socket bytes separately. Record queue items and bytes, dropped/coalesced counts, receipt cache payload bytes and metadata count, closed records, capture images, execution-value entries, and pending detail reads. Do not log payloads or credentials.

Use a single reproducible workload set: idle Workspace, static page, animation, real wheel input, long Teaching, 10,000-action Run, 100 create/close cycles, narrow/wide discovery, large DevTools responses, one stalled consumer, multiple viewers, and cancellation. Include web, Android and iOS where the finding applies. Warm up for five seconds for steady workloads, then collect at least five paired 30-second windows per variant, alternate baseline/candidate order, and report median and p95 plus spread. Freeze viewport, DPR, transport, fixture, recording state, machine pressure, and build revision. Report p95 from per-frame or per-operation samples within each window, with sample count and per-window distribution. Five run totals are not enough for a meaningful run-level p95. Report CPU as delta CPU-ms over the same 30-second steady window, startup separately. Sample process-tree RSS at 100-ms intervals and label peaks as sampled; a sub-100-ms transient may be missed. For retained-heap plateaus, take samples after workload quiescence and controlled GC, then repeat another batch to check growth. Predeclare a 10% improvement gate for CPU/wire/latency work and no >5% regression outside the target workload, subject to baseline variability; increase sampling when variation exceeds those margins. These are proposed engineering gates, not measured guarantees.

For memory, record Node heap, external, ArrayBuffers, child RSS, Chromium and encoder RSS, and aggregate process-tree peaks. Sample during work and after controlled GC when available. RSS need not immediately fall when objects become unreachable. Heap snapshots identify unique retaining paths and shared objects. A stable cache payload counter cannot establish stable whole-process RSS.

Use event-controlled consumers and TestClock for correctness tests, not wall-clock sleep assertions. Keep measurements separate from deterministic unit verdicts. For runtime changes, run `vp exec turbo run quality`, affected unit/integration tests, and the `verify-contingency` acceptance paths on the final revision. Read `docs/agents/verification.md` before writing the implementation verification brief. Any user-visible behavior change also updates the verification skill through `maintain-verification-skill`.

Land the work in focused changes with per-module kill switches or reversible defaults where practical. Keep baseline codecs and full/history reads until compatibility gates pass. A failed replay, missing authority state, corrupted recording, or incomplete cleanup blocks rollout regardless of a performance score.

## Reviewed and not promoted to findings

- `teaching-capture.ts` caps snapshots and keyframes at 400 and removes orphaned image hashes. Those limits bound item count, not total image bytes; measure capture byte retention before adding spill-to-disk. Clearing the capture at Stop requires ensuring the durable learner no longer reads it.
- `agent-browser.ts` already disposes old ElementHandles, caps live references, and limits continuation entries. Text snapshots replace structured nodes rather than duplicating both. Existing text/diff and pagination should be used before inventing another format.
- `apps/web/src/lib/retained-state.ts` keeps at most 16 values per retained family. It is intentional bounded UI retention.
- The legacy `browser-devtools-state.ts` permits 10,000 items per tab and growing ignored IDs, but no runtime callers were found. Do not claim it is current UI memory consumption without a reachable caller.
- Catalog/store maps, native workspace receipts, Run evidence sets, modification history, and download lists deserve heap attribution. They are secondary profiling targets, not proven dominant leaks. `runTimeline` has a confirmed live append path and a confirmed summary reader. Finding 2 proposes replacing that reader before releasing its retained history.
- Bundle splitting, codec compression, worker pools, and broad collection rewrites are deferred until startup/CPU profiles justify them. Do not compromise strict schema validation to save bytes.

This audit records the original HEAD findings. See [implemented changes](performance-implementation-2026-11-04.md) and [runtime measurements](performance-runtime-2026-11-04.md) for the completed scope and results.
