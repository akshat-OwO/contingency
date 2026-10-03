# Browser streaming

The Workspace drives Chromium through Playwright in the CLI process. Domain language lives in [`CONTEXT.md`](../../CONTEXT.md). [ADR 0012](../adr/0012-playwright-is-the-in-process-browser-runtime.md) records why Playwright replaced the bundled browser binary, and [ADR 0038](../adr/0038-contingency-is-an-agent-sanity-monitor.md) records why one MCP-owned browser is the sole runtime.

## Status

| Piece                                                  | Status |
| ------------------------------------------------------ | ------ |
| Live browser session, tabs, viewport, user-agent       | Built  |
| Screencast frames to a canvas + pointer/keyboard input | Built  |
| Console / Network / Storage DevTools panels            | Built  |
| Teaching, Flow Skill Dry Run, Run Summary              | Built  |

## Packages

- **`apps/web`** — the Workspace UI, Effect Atom RPC client over `/ws`.
- **`packages/cli`** — `contingency mcp` (and `contingency web` for the UI alone) HTTP server, Effect RPC handlers, and the Playwright-backed `CreateBrowser` service.
- **`packages/protocol`** — shared Effect Schema + `ContingencyRpcs` for Agent Session browser/stream/input.

## Runtime path

```text
Workspace (canvas)
    │  mouse / keyboard / navigation (Effect RPC)
    ▼
CLI HTTP server  ──/ws──  ContingencyRpcs
    │
    ▼
CreateBrowser service  ──Playwright──  Chromium
    │
    └── Playwright CDP session for screencast and raw canvas input
            │
            └── frames / status / url / console / tabs
            │
            ▼
        BrowserStreamEvent (RPC stream)
            │
            ▼
        Canvas blit + DevTools state in web UI
```

Playwright has no public live-screencast API, so `CreateBrowser` opens a Playwright CDP session and calls Chrome's `Page.startScreencast`. CDP never crosses the RPC boundary. The web app receives `BrowserStreamEvent` and sends `BrowserInput`. The capture service owns Chromium's frame acknowledgements.

## Session model

- The browser handle is owned by the server process and addressed through an Agent Session; it never leaves that process.
- RPCs cover: open URL, back/forward/reload, viewport, user-agent profile, tabs, network request inspection, Storage inspect/mutate (cookies, `localStorage`, `sessionStorage`), input, stream subscribe, frame ack.
- Stream events: `frame` (JPEG payload + metadata), `status` (connected / screencasting), `url`, console / page_error, `tabs`.

## Input and backpressure

1. User events on the canvas become `BrowserInput` (`input_mouse` | `input_keyboard`).
2. Web sends the Agent Session input RPC; the CLI dispatches it through the active Page's Playwright CDP session.
3. Chrome emits a JPEG frame with a private protocol session id. The CLI assigns a public stream id and sequence number, then publishes the unchanged JPEG into a sliding frame queue with capacity one and one-frame replay.
4. After publication, the CLI sends `Page.screencastFrameAck`. Failed acknowledgements retry twice; a persistent failure stops that capture and reports a disconnected stream. Viewer speed does not control Chromium's credits.
5. Each subscriber merges frames with the separate control-event stream. A slow subscriber skips superseded frames before serialization. Control events do not compete with frames for queue space. Frames from a retired capture are filtered before delivery.
6. The Workspace uses an RPC stream buffer of one event and keeps only the latest waiting frame while decoding. A decode checks its session and stream again before drawing. Decode and draw failures appear as browser stream errors; a successful frame clears that error. Every decoded bitmap is closed, including cancelled or failed draws.

Capture starts with the first stream subscription and stops when the last subscription closes. Teaching holds its own subscription, so recording continues when the Workspace closes. The recorder shares the bounded frame stream and retains its existing policy of dropping frames when its encoder cannot keep up. Neither viewing nor recording sends per-frame acknowledgement RPCs. The acknowledgement RPC remains available for clients using an earlier UI build; it validates the capture id without sending another Chromium acknowledgement.

Input has a separate ordered queue. Pending wheel samples for the same position, modifiers, and direction add their deltas together. Reversals, changed targets, keys, clicks, and session changes remain boundaries. Dispatching every trackpad sample separately accumulated roughly one second of trailing movement during a one-second, 120-sample gesture, even while capture delivered around 60 frames per second. Combining pending samples preserves distance and prevents that backlog.

The capture matrix's scroll workload uses `window.scrollTo`, so it does not measure wheel-input delay. Its JPEG-80 and JPEG-90 JSON animation cases both received approximately 60 frames per second. That baseline already uses the bounded pipeline; these results establish neither an FPS increase over the original implementation nor a physical display FPS measurement. The separate wheel benchmark exercises the Workspace queue and real Agent Session input. Before wheel coalescing, its queue drained 990 ms after the gesture ended without recording and 1,158 ms with recording. After the fix, down and down/up cases reached their final frame within 17–59 ms after input ended in the measured run. These wheel results end at the service stream, excluding RPC network and viewer drawing.

Capture defaults to JPEG quality 90, with a maximum pixel ratio of two. The server decodes CDP's base64 once into bytes; neither transport re-encodes the image. The default `/ws` JSON codec preserves the legacy base64 wire shape. The optional `/ws/browser` Schema Binary codec carries bytes directly. Teaching writes those same JPEG bytes to its encoder.

The canvas retains the decoded bitmap's physical dimensions. Pointer coordinates and Inspect overlays use the logical viewport, and CSS constraints preserve the image's aspect ratio. A higher capture ceiling does not create source detail: the tested headless Chromium emitted a 640 by 480 screencast for a 640 by 480 viewport at emulated DPR 1, 2, and 3. JPEG remains lossy, and the bounded stream can skip superseded repaints.

## Streaming preference and diagnostics

The Workspace's browser tools rail exposes **Stream diagnostics** and a session-specific **Streaming preference**. **Local performance** uses JSON by default. **Lower bandwidth** reconnects the viewer using Schema Binary without changing the recording subscription. The recorder continues to use the same capture quality.

The local benchmark compared actual screencast images against a PNG reference:

| Capture | Image bytes | Whole-image PSNR | Text-region PSNR |
| ------- | ----------: | ---------------: | ---------------: |
| JPEG 80 |      38,294 |         36.42 dB |         35.07 dB |
| JPEG 90 |      48,843 |         38.25 dB |         36.53 dB |
| JPEG 95 |      60,653 |         39.10 dB |         37.23 dB |
| PNG     |      92,382 |         Lossless |         Lossless |

JPEG 90 improves text fidelity while remaining compatible with the bundled Teaching encoder. JPEG 95 costs another 24% in image bytes for less than one additional dB on this fixture. PNG is a benchmark reference; the bundled encoder has no PNG decoder.

A ten-second animation comparison received 601 frames per transport. Schema Binary reduced wire bytes by approximately 25% and receipt p95 from 4.23 to 3.33 ms. However, combined Node RPC client/server steady CPU increased from 1,367 to 2,346 ms, approximately 72%. These CPU measurements exclude Chromium and ffmpeg. JSON therefore remains the local default; binary is available when bandwidth matters more than process CPU.

Diagnostics track received and rendered frames, image bytes, sequence gaps, superseded pending frames, stale/cancelled frames, failures, pending depth, and decode depth. Latency uses the server's CDP callback receipt time, rather than Chrome's compositor paint timestamp. Replayed frames are counted but excluded from latency. The last 120 samples are retained, and displayed snapshots update at most twice per second. Capture receipt to canvas includes decode and draw submission, not physical screen presentation; remote clock skew can affect cross-process age measurements.

The 96-case local matrix passed the freshness, decode, fidelity, recording, and binary overhead budgets. Changing workloads had receipt p95 of 3.08–4.43 ms with fast readers and 306.99–322.48 ms with deliberately slow readers. Decode p95 stayed at or below 2.5 ms. A live DPR-2 Workspace measured capture receipt to canvas p95 of 5 ms; DPR-3 binary viewing also passed recording, rapid input, and Inspect outline alignment. These are local fixture measurements, not guarantees for remote networks. See [the benchmark procedure](browser-streaming-benchmark.md) to reproduce them.

## Session state

Each session owns one Playwright browser context. Tabs are Pages within that context, so cookies and origin storage survive tab changes. Viewport changes update every Page in place. User-agent changes use `Network.setUserAgentOverride` on the existing Pages and future Pages inherit the override. Neither operation replaces the context, so changing the user agent cannot discard cookies, `localStorage`, or `sessionStorage`.

Storage reads and writes use Playwright's context cookie APIs and Page evaluation for web storage. Mutations are live-only, and control is exclusive between the agent and the user (Takeover).

## How to run locally

```sh
# Teaching and Interactive Runs — the MCP server owns Agent Sessions
nub exec contingency mcp

# the Workspace alone, without MCP
nub exec contingency web
```

Production builds can serve the SPA from the CLI (`serveWebUi`). Dev typically uses the Vite app against the CLI WebSocket origin allowlist.
