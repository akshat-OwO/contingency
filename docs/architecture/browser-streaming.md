# Browser streaming

The Workspace drives Chromium through Playwright in the CLI process. Domain language lives in [`CONTEXT.md`](../../CONTEXT.md). [ADR 0012](../adr/0012-playwright-is-the-in-process-browser-runtime.md) records why Playwright replaced the bundled browser binary, and [ADR 0038](../adr/0038-contingency-is-an-agent-sanity-monitor.md) records why one MCP-owned browser is the sole runtime.

## Status

| Piece                                                  | Status |
| ------------------------------------------------------ | ------ |
| Live browser session, tabs, viewport, user-agent       | Built  |
| Screencast frames to a canvas + pointer/keyboard input | Built  |
| Console / Network / Storage DevTools panels            | Built  |
| Teaching, Agent Flow verification, Run Summary         | Built  |

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

Playwright has no public live-screencast API, so `CreateBrowser` opens a Playwright CDP session and calls Chrome's `Page.startScreencast`. CDP never crosses the RPC boundary. The web app receives only the existing `BrowserStreamEvent` contract and sends the existing `BrowserInput` and frame acknowledgement messages.

## Session model

- The browser handle is owned by the server process and addressed through an Agent Session; it never leaves that process.
- RPCs cover: open URL, back/forward/reload, viewport, user-agent profile, tabs, network request inspection, Storage inspect/mutate (cookies, `localStorage`, `sessionStorage`), input, stream subscribe, frame ack.
- Stream events: `frame` (JPEG payload + metadata), `status` (connected / screencasting), `url`, console / page_error, `tabs`.

## Input and backpressure

1. User events on the canvas become `BrowserInput` (`input_mouse` | `input_keyboard`).
2. Web sends the Agent Session input RPC; the CLI dispatches it through the active Page's Playwright CDP session.
3. Chrome emits one JPEG frame with a protocol session id. The CLI assigns the public stream id and sequence number, then publishes the unchanged frame event.
4. Web acknowledges the frame. The CLI resolves that public sequence back to Chrome's private session id and sends `Page.screencastFrameAck`.

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
