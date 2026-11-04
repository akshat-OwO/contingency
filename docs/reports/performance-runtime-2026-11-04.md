# Runtime performance measurements

The Network panel's list RPC is faster on the measured fixture. This experiment did not establish reduced whole-process memory or faster frame delivery.

## Results

Values below average two run-level summaries per revision. Latency values average each run's median; they are not pooled percentiles.

| Metric | Original HEAD | Changed code | Interpretation |
| --- | --: | --: | --- |
| Network-list throughput | 15,440 requests/s | 22,716 requests/s | 47.1% higher |
| Network-list median round trip | 0.0545 ms | 0.0413 ms | 24.3% lower |
| Scroll input to first received moved frame, median | 33.31 ms | 33.34 ms | Essentially unchanged |
| Delivered frame rate | 31.25 FPS | 31.25 FPS | Unchanged |
| Active MCP server RSS, median | 582.3 MiB | 577.7 MiB | Run ranges overlap; no demonstrated saving |
| All owned app/browser processes, summed median RSS | 2,784.1 MiB | 2,777.0 MiB | 0.26% lower; within observed variation |

The Network-list rate ranged from 14,973–15,906 requests/s before and 22,312–23,120 afterward. Each original median round trip was 0.0535–0.0556 ms; each changed median was 0.0405–0.0421 ms. Those ranges do not overlap in this small experiment.

Frame-rate measurements were 31.25 FPS in all four runs, matching the fixture's 32 ms animation cadence. Scroll median latency ranged from 33.25–33.38 ms before and 33.34 ms afterward. Average run-level p95 scroll times were 42.41 ms before and 34.64 ms afterward, but the original run-level p95 varied from 35.14 to 49.68 ms. Thirty scroll observations per run and two runs per revision are insufficient for a firm tail-latency claim.

The candidate process-tree median ranged from 2,769.5 to 2,784.4 MiB; the original ranged from 2,780.0 to 2,788.2 MiB. Server medians ranged from 571.5 to 583.9 MiB after versus 582.1 to 582.6 MiB before. The small mean differences are not evidence of durable RAM savings. Queue and retention caps from the implementation tests remain valid, but this normal fast-consumer workload does not stress an unbounded subscriber backlog or wait 30 minutes for idle expiry.

## Method

- Baseline commit: `b92a4b96e60390f5e43c9d1ceea18284a1bbe7b4`. The candidate is the current uncommitted implementation. The runner temporarily restores tracked runtime source to HEAD for baseline builds, checks for concurrent edits before restoring candidate bytes, and finishes with a candidate production build.
- One isolated production stack at a time, using verify-contingency launch/doctor/MCP/cleanup. Order: candidate, baseline, baseline, candidate. Two measured runs per revision. A separate pilot is excluded.
- A local fixture animates a 640×480 canvas every 32 ms and records two network rows, including a response with a 4 KiB padding header. Workspace opens the real session. A second real JSON WebSocket consumer observes browser frames.
- Four-second warmup, then 12 seconds of sequential Network-list RPC requests over a persistent WebSocket while streaming. This is a saturation benchmark of that RPC, not the normal UI polling rate or general MCP tool throughput. Each revision does more or less work in the same interval according to its achieved request rate.
- Thirty native scroll inputs follow the load interval. One receiver monotonic clock measures input dispatch to receipt of the first frame whose scroll offset advances. This includes input transport and browser capture/receive delay; it excludes canvas draw and physical screen presentation. The test does not use capture timestamps to calculate latency: the pilot found negative cross-clock values, which are retained as invalid diagnostic data and excluded from conclusions.
- External `ps` sampling about every 250 ms records RSS for the web process, MCP broker and server, Workspace driver, and their Chromium descendants. The active server is the child of the MCP broker. The process-tree total sums RSS, so shared pages may be counted repeatedly. It is not unique physical memory or system-wide RAM. Benchmark/fixture/probe processes are excluded. No explicit GC is forced.
- The machine had about 81–84% free memory and approximately 1.90 GiB of pre-existing swap allocated throughout. No growth in swap was observed. This was a local macOS run without network shaping; results are not a WAN benchmark.

## Evidence and cleanup

Raw data, workload code and logs are under `.cursor/skills/verify-contingency/artifacts/performance-runtime/`:

- `summary.json`: per-run statistics and arithmetic means of run summaries.
- `*-result.json`: frame and request observations, timings and payload sizes.
- `*-memory.json`: phase-labelled RSS samples and owned PID trees.
- `probe.mjs` and `run.py`: fixture, workload, protected source restoration, sampling and resource lifecycle.
- `journal.json`: command arguments, owners, PIDs, timestamps and exits. Every measured build, launch, doctor, MCP, probe and cleanup exited zero.
- `*-cleanup-check.json` and `descendant-cleanup.json`: all stack ports and fixture ports closed; all 76 sampled owned PIDs absent after cleanup.
- `manifest.json`: baseline commit, final restored candidate source hashes and workload hashes. Candidate hashes were recorded after the protected source restoration, not at each sampling instant.

No product source changed for this experiment. The result supports faster header-heavy Network-list RPC processing. It does not support claiming that the browser stream itself got faster or that whole-process RAM materially decreased.

The committed [summary](performance-runtime-2026-11-04/summary.json), [command journal](performance-runtime-2026-11-04/journal.json), and [cleanup check](performance-runtime-2026-11-04/descendant-cleanup.json) retain the aggregate evidence. To reproduce, copy [probe.mjs.txt](performance-runtime-2026-11-04/probe.mjs.txt) and [run.py.txt](performance-runtime-2026-11-04/run.py.txt) into `.cursor/skills/verify-contingency/artifacts/performance-runtime/` as `probe.mjs` and `run.py`, then run `python3 .cursor/skills/verify-contingency/artifacts/performance-runtime/run.py`. The runner builds and restores baseline runtime source temporarily; run it without concurrent source edits. Raw per-request and RSS samples remain local artifacts rather than committed bulk data.
