# Create View: browser streaming (historical)

> **Superseded.** [ADR 0012](../adr/0012-playwright-is-the-in-process-browser-runtime.md) replaces the bundled `agent-browser` binary and its CDP sidecars with in-process Playwright, and that work deleted everything this document describes in its present-tense sections. The text below is kept as a record of the design it superseded; the Create View rebuild on Playwright (#51–#53) will document its own streaming design.

Historical context: this described what existed for the Create View live browser before the Playwright migration. Domain language lives in [`CONTEXT.md`](../../CONTEXT.md). Canvas, screencast, CDP, and agent-browser were runtime concerns — not glossary terms.

## Status

| Piece | Status |
| --- | --- |
| Live browser session, tabs, viewport, user-agent | Built |
| Screencast frames to a canvas + pointer/keyboard input | Built |
| Console / Network / Storage DevTools panels | Built |
| Recording → Flow (Steps, Pre-steps, Audit Steps, Variables) | Built |
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

Contingency does not expose CDP to the web app. Browser streaming and input stay behind `agent-browser`; during a Recording, a CLI-owned CDP sidecar injects the recorder into restricted isolated worlds and relays only validated semantic actions. See [ADR 0004](../adr/0004-cli-owned-cdp-recorder-sidecar.md).

The injected recorder also renders an authoring-only hover inspector inside each instrumented frame. It shows a blue target outline with bounded tag, ARIA, and geometry metadata. The inspector does not emit hover data into the Recording or Flow and is removed when capture stops.

## Session model

- Session IDs are branded strings matching `create-[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.
- RPCs cover: list/create/attach/close session, open URL, back/forward/reload, viewport, user-agent profile, tabs, network request inspection, Storage inspect/mutate (cookies, `localStorage`, `sessionStorage`), input, stream subscribe, frame ack.
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

- Runner execution of Pre-steps and Audit Steps, plus Findings — see [`../future/product-path.md`](../future/product-path.md).
- agent-browser features not yet wrapped (DOM snapshot, axe audit, video `record`, `state save/load`, `--restore`) — available in the bundled binary, unused by Contingency's protocol today. Storage DevTools does not wrap `state save/load` or `--restore`.
