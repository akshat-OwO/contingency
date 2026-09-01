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
- For `agent-empty-mcp`, you started `mcp` yourself on a private `CONTINGENCY_MCP_PORT` and a private `CONTINGENCY_STATE_DIR`. This helper's `launch` does not start MCP. If you did not start `mcp`, skip those bullets and report the skip.

- **Nav entry.** From Create View choose Agent. Run `control-contingency browser goto --path /`, then `control-contingency browser click --role link --name Agent`. The `Agent` link is current.
- **Unavailable on web.** After the query settles, wait for the error heading. Run `control-contingency browser wait --role heading --name "Agent Session unavailable"`. The description is `Agent Sessions are unavailable in this server process.`
- **Direct route.** Open `/agent` without using nav. Run `control-contingency browser goto --path /agent`. The same unavailable heading is visible.
- **Unknown session query.** Open a fake session id. Run `control-contingency browser goto --path "/agent?session=not-a-session"`. Still unavailable. The page does not treat the query value as a credential.
- **Proof.** Capture the web unavailable state. Run `control-contingency browser snapshot --aria --path agent-view/unavailable.aria.txt` and `control-contingency browser screenshot --path agent-view/unavailable.png`. Both show Contingency, current `Agent`, and `Agent Session unavailable`.

## Gotchas

- `Loading Agent Sessions…` is transient. Wait for `Agent Session unavailable` or `No active Agent Sessions`. Do not snapshot the spinner.
- Empty and unavailable are different. Empty means this MCP process is up and currently has zero sessions. Unavailable means this process is not an MCP owner, or the requested id is gone.
- Closing Agent View does not pause a real session. That sentence appears only on the live view, which this `web` launch cannot show.
- Do not start `mcp` on 7777 if the user already has Contingency there.
