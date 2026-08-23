# Create View browser streaming

Create View drives Chromium through Playwright in the CLI process. Domain language lives in [`CONTEXT.md`](../../CONTEXT.md). [ADR 0012](../adr/0012-playwright-is-the-in-process-browser-runtime.md) records why Playwright replaced the bundled browser binary.

## Status

| Piece | Status |
| --- | --- |
| Live browser session, tabs, viewport, user-agent | Built |
| Screencast frames to a canvas + pointer/keyboard input | Built |
| Console / Network / Storage DevTools panels | Built |
| Recording to Flow | Pending Playwright recorder work in #52 |
| Audit View / Runner / Runs | Built |

## Packages

- **`apps/web`** — Create View UI (`CreateWorkspace`, `BrowserWorkspace`), Effect Atom RPC client over `/ws`.
- **`packages/cli`** — `contingency web` HTTP server, Effect RPC handlers, and the Playwright-backed `CreateBrowser` service.
- **`packages/protocol`** — Shared Effect Schema + `ContingencyRpcs` for browser session/stream/input.

## Runtime path

```text
Create View (canvas)
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

Playwright has no public live-screencast API, so `CreateBrowser` opens a Playwright CDP session and calls Chrome's `Page.startScreencast`. CDP never crosses the RPC boundary. The web app receives only the existing `BrowserStreamEvent` contract and sends the existing `BrowserInput` and frame acknowledgement messages.

## Session model

- Session IDs are branded strings matching `create-[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
- RPCs cover: list/create/attach/close session, open URL, back/forward/reload, viewport, user-agent profile, tabs, network request inspection, Storage inspect/mutate (cookies, `localStorage`, `sessionStorage`), input, stream subscribe, frame ack.
- Stream events: `frame` (JPEG payload + metadata), `status` (connected / screencasting / optional `recording` flag unused by UI today), `url`, console / page_error, `tabs`.

## Input and backpressure

1. User events on the canvas become `BrowserInput` (`input_mouse` | `input_keyboard`).
2. Web sends `browser.input.send`; the CLI dispatches it through the active Page's Playwright CDP session.
3. Chrome emits one JPEG frame with a protocol session id. The CLI assigns the public stream id and sequence number, then publishes the unchanged frame event.
4. Web acknowledges with `browser.frame.ack`. The CLI resolves that public sequence back to Chrome's private session id and sends `Page.screencastFrameAck`.

## Session state

Each Create View session owns one Playwright browser context. Tabs are Pages within that context, so cookies and origin storage survive tab changes. Viewport changes update every Page in place. User-agent changes use `Network.setUserAgentOverride` on the existing Pages and future Pages inherit the override. Neither operation replaces the context, so changing the user agent cannot discard cookies, `localStorage`, or `sessionStorage`.

Storage reads and writes use Playwright's context cookie APIs and Page evaluation for web storage. The RPC layer keeps mutations live-only and locks them only for the session pinned by an unfinished Recording.

## How to run locally

```sh
# from repo root — starts CLI server and opens the web UI (dev URL via CONTINGENCY_WEB)
nub exec contingency web
```

Production builds can serve the SPA from the CLI (`serveWebUi`). Dev typically uses the Vite app against the CLI WebSocket origin allowlist.

## Intentionally out of scope here

- Recorder injection and captured Step construction are handled by #52.
- Trace capture and Run video belong to the Runner, not Create View sessions.
