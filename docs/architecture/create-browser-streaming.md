# Create View: browser streaming (current)

This describes what exists today for the Create View live browser. Domain language lives in [`CONTEXT.md`](../../CONTEXT.md). Canvas, screencast, CDP, and agent-browser are runtime concerns — not glossary terms.

## Status

| Piece | Status |
|-------|--------|
| Live browser session, tabs, viewport, user-agent | Built |
| Screencast frames to a canvas + pointer/keyboard input | Built |
| Console / network DevTools panels | Built |
| Recording → Flow (steps, Pre-steps, Audits) | Not built (instructions panel is stub UI) |
| Audit View / Runner / Runs | Not built (Audit route is a placeholder) |

## Packages

- **`apps/web`** — Create View UI (`CreateWorkspace`, `BrowserWorkspace`), Effect Atom RPC client over `/ws`.
- **`packages/cli`** — `contingency web` HTTP server, Effect RPC handlers, `AgentBrowser` adapter, bundled `agent-browser` binaries.
- **`packages/protocol`** — Shared Effect Schema + `ContingencyRpcs` for browser session/stream/input.

## Runtime path

```text
Create View (canvas)
    │  mouse / keyboard / navigation (Effect RPC)
    ▼
CLI HTTP server  ──/ws──  ContingencyRpcs
    │
    ▼
AgentBrowser service
    │  CLI subprocess + local stream WebSocket
    ▼
agent-browser  ──CDP──  Chrome for Testing
    │
    └── screencast frames / status / url / console / tabs
            │
            ▼
        BrowserStreamEvent (RPC stream)
            │
            ▼
        Canvas blit + DevTools state in web UI
```

Contingency does not expose CDP to the web app. CDP stays inside `agent-browser`; the CLI relays a typed stream and command surface.

## Session model

- Session IDs are branded strings matching `create-[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
- RPCs cover: list/create/attach/close session, open URL, back/forward/reload, viewport, user-agent profile, tabs, network request inspection, input, stream subscribe, frame ack.
- Stream events: `frame` (JPEG payload + metadata), `status` (connected / screencasting / optional `recording` flag unused by UI today), `url`, console / page_error, `tabs`.

## Input and backpressure

1. User events on the canvas become `BrowserInput` (`input_mouse` | `input_keyboard`).
2. Web sends `browser.input.send`; CLI calls `AgentBrowser.sendInput`.
3. Frames arrive on `browser.stream.subscribe`; the UI acknowledges with `browser.frame.ack` so the stream can apply backpressure.

## How to run locally

```sh
# from repo root — starts CLI server and opens the web UI (dev URL via CONTINGENCY_WEB)
nub exec contingency web
```

Production builds can serve the SPA from the CLI (`serveWebUi`). Dev typically uses the Vite app against the CLI WebSocket origin allowlist.

## Intentionally out of scope here

- Flow schema, Recording capture, Pre-steps, Audits, Findings — see [`../future/product-path.md`](../future/product-path.md).
- agent-browser features not yet wrapped (DOM snapshot, axe audit, video `record`, state restore) — available in the bundled binary, unused by Contingency's protocol today.
