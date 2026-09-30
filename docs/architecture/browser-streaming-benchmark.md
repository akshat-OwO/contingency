# Benchmark browser streaming

Run from the repository root with installed dependencies and a local Chromium available to Playwright.

```sh
nub packages/cli/tests/benchmarks/browser-streaming.ts --check
```

The matrix covers DPR 1/2/3, JSON/binary transport, recording on/off, fast/slow readers, and static/scroll/typing/animation workloads: 96 cases. Quality comparisons cover JPEG 80/90/95 and PNG using screenshots and actual CDP screencast frames. The script exits nonzero if a checked budget fails.

To compare the former capture defaults against the current bounded pipeline:

```sh
STREAM_BENCHMARK_BASELINE=1 nub packages/cli/tests/benchmarks/browser-streaming.ts --check
```

This 48-case baseline uses JPEG 80, a one-times capture ceiling, and JSON. It does not restore the original unbounded queue or viewer acknowledgement behavior.

For a longer transport CPU comparison:

```sh
STREAM_BENCHMARK_FOCUS=1 STREAM_BENCHMARK_SAMPLE_MS=10000 nub packages/cli/tests/benchmarks/browser-streaming.ts
```

This compares JSON and binary animation at DPR 1 with fast readers and no recording. It separates startup CPU from steady CPU. The default full-matrix sample lasts 1,500 ms per case; `STREAM_BENCHMARK_SAMPLE_MS` accepts 500–30,000 ms.

Use `--quality-only` to skip streaming, or `--check-existing` to check a saved full report without launching Chromium. Reports, reference images, and recordings are saved under `.cursor/skills/verify-contingency/artifacts/streaming-benchmark/` in `candidate`, `baseline`, or `candidate-focus`. Artifacts are ignored by Git.

## Interpret the report

To measure the ordered input path rather than scripted page scrolling:

```sh
nub packages/cli/tests/benchmarks/browser-scroll.ts --check
```

This sends 120 wheel samples at an eight-millisecond requested cadence through the actual Workspace input queue and Agent Session. It tests down and down/up gestures before and during recording, checks arrival of the final scroll position, and requires input drain and final-frame tail at most 150 ms. Actual gesture duration is reported because timer scheduling varies. Reports land in `artifacts/streaming-scroll/`; `SCROLL_BENCHMARK_LABEL` changes the filename. The frame endpoint is the service stream, excluding the WebSocket and canvas. The fixture appends rows near the bottom to support live infinite-scroll checks.

The capture matrix changes scroll position with `window.scrollTo`; it bypasses the input queue and cannot establish wheel responsiveness. Received frame counts divided by the sampling window estimate transport throughput for changing workloads, not displayed FPS. JPEG-80 and JPEG-90 JSON animation both measured about 60 received frames per second. The JPEG-80 baseline includes the new bounded pipeline, so it is not a comparison with the original acknowledgement implementation.

Capture receipt to receive ends at the Node RPC client, not at the Workspace canvas. Decode and draw are sampled in Chromium separately. The live Workspace diagnostics provide the viewer's receipt-to-canvas measurement. Draw measures submission, not the subsequent physical display refresh.

CPU includes the Node client and server in the benchmark process; Chromium and ffmpeg CPU are excluded. Static frame counts are paint events, not FPS. Changing-workload freshness excludes replay from before that workload. Slow readers deliberately delay consumption by 100 ms per frame.

Image PSNR compares against a PNG from the same capture path. Native-DPR screenshot comparisons expose upstream resolution loss separately. Teaching cases use the real encoder and check accepted bytes and reported encoder failures; recording playback is covered by the integration tests.

Budgets live in [`browser-streaming-budget.ts`](../../packages/cli/tests/benchmarks/browser-streaming-budget.ts): fast receipt p95 at most 100 ms, slow receipt p95 at most 400 ms, decode p95 at most 20 ms, JPEG-90 whole/text PSNR at least 38/36 dB, and dynamic fast binary wire/image ratio at most 1.08. Every case must receive frames, and every recording case must accept encoder bytes without an encoder failure. Static cases do not receive freshness or overhead budgets.
