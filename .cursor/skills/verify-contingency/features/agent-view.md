# Agent View

Agent View watches Teaching and Interactive Runs owned by one local MCP process, and hands the browser to the user on request. On `contingency web` there is no Agent Session registry, so the page reports that sessions are unavailable. On `contingency mcp` with no activity it reports that none are active. With a live session it shows the browser, the action timeline, and one control button; during Takeover the user drives that browser with the toolbar and the canvas.

## Sub-features

- `agent-nav` reaches Agent View from primary navigation.
- `agent-unavailable-web` shows unavailability on a `web` launch.
- `agent-empty-mcp` shows `No active Agent Sessions` on an MCP launch with no Teaching or Run.
- `agent-bad-session` shows unavailability when `?session=` names a session this process does not own.
- `agent-live-session` shows a live session's browser, status, and timeline.
- `agent-watching-readonly` disables the browser toolbar and marks the canvas read-only while the agent holds control.
- `agent-takeover-controls` enables history, address, and canvas input once the user takes control.
- `agent-takeover-timeline` records what the user did as `You`, and follows the browser's URL.
- `agent-return-control` hands the browser back, and the toolbar goes quiet again.

## How to get to it (user POV)

- Choose the `Agent` link in primary navigation.
- Open `/agent` directly.
- Open the URL printed by `contingency mcp`: `http://127.0.0.1:<port>/agent`.
- Follow an MCP client's local Agent View link that includes `?session=<id>`.

## Driving it with control-contingency

Preconditions:

- For `agent-nav` and `agent-unavailable-web`, the verification instance is a `web` launch (the default `control-contingency launch`).
- For `agent-empty-mcp`, run `control-contingency mcp start` on the same verify directory after `launch` and `doctor`. That binds MCP on an ephemeral port with the isolated `stateDir`. Do not attach to an MCP process you did not start.
- For every live-session sub-feature, `mcp start` and `ecommerce start` must both be running. Create the session with `control-contingency mcp call`, which speaks MCP to that same process — a session exists only inside the process that owns it, so nothing else can conjure one.

- **Nav entry.** From Create View choose Agent. Run `control-contingency browser goto --path /`, then `control-contingency browser click --role link --name Agent`. The `Agent` link is current.
- **Unavailable on web.** After the query settles, wait for the destructive alert. Run `control-contingency browser wait --role alert --has-text "Agent Session unavailable" --timeout-ms 15000`. The description includes `Agent Sessions are unavailable in this server process.`
- **Direct route.** Open `/agent` without using nav. Run `control-contingency browser goto --path /agent`, then the same alert wait as above.
- **Unknown session query.** Open a fake session id. Run `control-contingency browser goto --path "/agent?session=not-a-session"`, then the same alert wait. The page does not treat the query value as a credential.
- **Empty on MCP.** Start MCP on the verify instance. Run `control-contingency mcp start`, then `control-contingency browser goto --url "$mcpUrl/agent"` using the printed `mcpUrl`. Wait with `control-contingency browser wait --role heading --name "No active Agent Sessions" --timeout-ms 15000`.
- **Proof (web unavailable).** Capture the web unavailable state. Run `control-contingency browser goto --path /agent`, wait for the alert, then `control-contingency browser snapshot --aria --path agent-view/unavailable.aria.txt` and `control-contingency browser screenshot --path agent-view/unavailable.png`. Both show Contingency, current `Agent`, and `Agent Session unavailable`.
- **Proof (MCP empty).** After `mcp start`, capture the empty MCP state. Run `control-contingency browser goto --url "$mcpUrl/agent"`, wait for the empty heading, then `control-contingency browser snapshot --aria --path agent-view/empty-mcp.aria.txt` and `control-contingency browser screenshot --path agent-view/empty-mcp.png`.

### Live session and Takeover

- **Start a session.** Give the agent a browser on the local shop. Run `control-contingency mcp call --tool agent_session_start --params "{\"clientName\":\"verify\",\"clientVersion\":\"1.0\",\"operationId\":\"verify-agent-1\",\"url\":\"$ECOMMERCE_URL\",\"viewport\":{\"deviceScaleFactor\":1,\"height\":720,\"width\":1024}}"`. Stdout is the session snapshot; export its `id` as `sessionId` and its `viewUrl`.
- **Open the live view.** Run `control-contingency browser goto --url "$viewUrl"`, then `control-contingency browser wait --role button --name "Take control" --timeout-ms 20000`. The heading is `Agent View` and the status reads `Live` once frames arrive.
- **Watching is read-only.** Before taking control, snapshot the toolbar. Run `control-contingency browser snapshot --aria --path agent-view/takeover-watching.aria.txt`. `Go back`, `Go forward`, `Reload page`, and `Browser address` are all `[disabled]`, the address placeholder reads `Take control to drive the browser`, and the canvas `Live browser viewport` is `aria-readonly="true"`.
- **Take control.** Run `control-contingency browser click --role button --name "Take control"`, then `control-contingency browser wait --role button --name "Return control" --timeout-ms 15000`. The same toolbar handles are now enabled and the canvas is `aria-readonly="false"`.
- **Navigate by address.** Run `control-contingency browser fill --role textbox --name "Browser address" --value "${ECOMMERCE_URL%/*}/catalog.html"`, then `control-contingency browser press --key Enter --role textbox --name "Browser address"`. A bare host is completed to `https://`.
- **Navigate by history.** Run `control-contingency browser click --role button --name "Go back"`, then `control-contingency browser click --role button --name "Reload page"`. Each is dispatched one at a time; a second click while one is pending is refused by the disabled state rather than racing it.
- **Scroll the page.** Wheel events belong to the nested browser, not to Contingency chrome. Drive them with `computerUse` at the verification URL over the `Live browser viewport` canvas. The page under the canvas scrolls; the View behind it does not.
- **Proof (what the user did).** Read the session back with `control-contingency mcp call --tool agent_session_get --params "{\"sessionId\":\"$sessionId\"}"`. `currentUrl` is where the browser now is, and the timeline carries `The user took control`, `Navigate to <url>`, `Go back`, and `Reload the page`, each with `"actor":"user"` and `"outcome":"completed"`. Agent View shows the same entries under `Action timeline` attributed to `You`.
- **Proof (the view itself).** Run `control-contingency browser snapshot --aria --path agent-view/takeover-driving.aria.txt` and `control-contingency browser screenshot --path agent-view/takeover-driving.png`.
- **Return control.** Run `control-contingency browser click --role button --name "Return control"`, then `control-contingency browser wait --role button --name "Take control" --timeout-ms 15000`. The toolbar is disabled again and the timeline gains `The user returned control to the agent`.

## Gotchas

- `Loading Agent Sessions…` is transient. Wait for the alert or the empty heading. Do not snapshot the spinner.
- Unavailable copy is a destructive `alert`, not a heading. `getByRole` name matching is unreliable here; use `browser wait --role alert --has-text "Agent Session unavailable"`.
- Empty and unavailable are different. Empty means this MCP process is up and currently has zero sessions. Unavailable means this process is not an MCP owner, or the requested id is gone.
- `?session=` on web still shows unavailable. On MCP with other sessions, a bad id may show a more specific message (`…is not owned by this MCP process…`).
- Closing Agent View does not pause a real session. That sentence appears only on the live view, which this `web` launch cannot show.
- Do not start `mcp` on 7777 if the user already has Contingency there. `mcp start` picks its own port.
- Only the user returns control. There is no MCP tool for it by design; an agent may only ask with `agent_session_takeover_request`. A drive that needs the agent driving again must click `Return control`.
- Raw input during Takeover is not in the timeline. Clicks, typing, and scrolling on the canvas leave no entry — only toolbar navigation and agent actions do. Prove a canvas interaction through `currentUrl` or the page itself, not the timeline.
- `agent_browser_screenshot` and `agent_browser_snapshot` keep working while the user holds control. Observation is not gated on control; action is.
- A failed tool call exits non-zero and prints the reason (`Element reference e12 is stale…`, `Could not find "X": Timeout…`). Assert on that text rather than on the exit code alone.
- Element references expire when the Page navigates. Take a fresh `agent_browser_snapshot` after any navigation before acting on a `ref`.
