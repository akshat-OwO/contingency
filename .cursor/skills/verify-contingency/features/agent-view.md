# Agent View

Agent View watches Teaching and Interactive Runs owned by one local MCP process. On `contingency web` there is no Agent Session registry, so the page reports that sessions are unavailable. On `contingency mcp` with no activity it reports that none are active.

## Sub-features

- `agent-nav` reaches Agent View from primary navigation.
- `agent-unavailable-web` shows unavailability on a `web` launch.
- `agent-empty-mcp` shows `No active Agent Sessions` on an MCP launch with no Teaching or Run.
- `agent-bad-session` shows unavailability when `?session=` names a session this process does not own.

## How to get to it (user POV)

- Choose the `Agent` link in primary navigation.
- Open `/agent` directly.
- Open the URL printed by `contingency mcp`: `http://127.0.0.1:<port>/agent`.
- Follow an MCP client's local Agent View link that includes `?session=<id>`.

## Driving it with control-contingency

Preconditions:

- For `agent-nav` and `agent-unavailable-web`, the verification instance is a `web` launch (the default `control-contingency launch`).
- For `agent-empty-mcp`, run `control-contingency mcp start` on the same verify directory after `launch` and `doctor`. That binds MCP on an ephemeral port with the isolated `stateDir`. Do not attach to an MCP process you did not start.

- **Nav entry.** From Create View choose Agent. Run `control-contingency browser goto --path /`, then `control-contingency browser click --role link --name Agent`. The `Agent` link is current.
- **Unavailable on web.** After the query settles, wait for the destructive alert. Run `control-contingency browser wait --role alert --has-text "Agent Session unavailable" --timeout-ms 15000`. The description includes `Agent Sessions are unavailable in this server process.`
- **Direct route.** Open `/agent` without using nav. Run `control-contingency browser goto --path /agent`, then the same alert wait as above.
- **Unknown session query.** Open a fake session id. Run `control-contingency browser goto --path "/agent?session=not-a-session"`, then the same alert wait. The page does not treat the query value as a credential.
- **Empty on MCP.** Start MCP on the verify instance. Run `control-contingency mcp start`, then `control-contingency browser goto --url "$mcpUrl/agent"` using the printed `mcpUrl`. Wait with `control-contingency browser wait --role heading --name "No active Agent Sessions" --timeout-ms 15000`.
- **Proof (web unavailable).** Capture the web unavailable state. Run `control-contingency browser goto --path /agent`, wait for the alert, then `control-contingency browser snapshot --aria --path agent-view/unavailable.aria.txt` and `control-contingency browser screenshot --path agent-view/unavailable.png`. Both show Contingency, current `Agent`, and `Agent Session unavailable`.
- **Proof (MCP empty).** After `mcp start`, capture the empty MCP state. Run `control-contingency browser goto --url "$mcpUrl/agent"`, wait for the empty heading, then `control-contingency browser snapshot --aria --path agent-view/empty-mcp.aria.txt` and `control-contingency browser screenshot --path agent-view/empty-mcp.png`.

## Gotchas

- `Loading Agent Sessions…` is transient. Wait for the alert or the empty heading. Do not snapshot the spinner.
- Unavailable copy is a destructive `alert`, not a heading. `getByRole` name matching is unreliable here; use `browser wait --role alert --has-text "Agent Session unavailable"`.
- Empty and unavailable are different. Empty means this MCP process is up and currently has zero sessions. Unavailable means this process is not an MCP owner, or the requested id is gone.
- `?session=` on web still shows unavailable. On MCP with other sessions, a bad id may show a more specific message (`…is not owned by this MCP process…`).
- Closing Agent View does not pause a real session. That sentence appears only on the live view, which this `web` launch cannot show.
- Do not start `mcp` on 7777 if the user already has Contingency there. `mcp start` picks its own port.
