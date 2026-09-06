# Agent View

Agent View watches Teaching and Interactive Runs owned by one local MCP process, and hands the browser to the user on request. On `contingency web` there is no Agent Session registry, so the page reports that sessions are unavailable. On `contingency mcp` with no activity it reports that none are active. With a live session it shows the browser, the action timeline, and one control button; during Takeover the user drives that browser with the toolbar and the canvas.

## Sub-features

- `agent-nav` reaches Agent View from primary navigation.
- `agent-unavailable-web` shows unavailability on a `web` launch.
- `agent-empty-mcp` shows `No active Agent Sessions` on an MCP launch with no Teaching or Run.
- `agent-bad-session` shows unavailability when `?session=` names a session this process does not own.
- `agent-live-session` shows a live session's browser, status, and timeline.
- `agent-same-document-snapshot` returns destination nodes with the destination URL after an agent action routes without loading a new document.
- `agent-watching-readonly` disables the browser toolbar and marks the canvas read-only while the agent holds control.
- `agent-takeover-controls` enables history, address, and canvas input once the user takes control.
- `agent-takeover-timeline` records what the user did as `You`, and follows the browser's URL.
- `agent-return-control` hands the browser back, and the toolbar goes quiet again.
- `agent-teaching-details` shows a Teaching session's captured action and instruction counts, the Teaching Feed disclosure, and the saved draft once one exists.
- `agent-teaching-draft` compiles a Teaching session into a draft Agent Flow through MCP, refuses invalid output with diagnostics, and finds the draft again by catalog search.
- `agent-execution-boundary` shows refused domains, new objectives, and per-attempt confirmation while preserving priority Takeover.
- `agent-private-variables` enters a reusable account and password plus a runtime OTP without putting their literals in the Teaching Feed or draft.

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
- **Route within the document.** Call `agent_browser_snapshot` and note the ref for the `Choose delivery area` button. Call `agent_browser_act` with that ref and a fresh operation id. Save stdout as `agent-view/same-document-act.json`: `snapshot.url` ends in `/shop.html/delivery`, its nodes include heading `Delivery area` and button `Use current location`, and no node is named `Choose delivery area`.
- **Proof (same-document reread).** Call `agent_browser_snapshot` again and save stdout as `agent-view/same-document-reread.json`; it reports the same URL and destination controls. In Agent View, save `agent-view/same-document.aria.txt` and `agent-view/same-document.png`; the live canvas is at the destination and the timeline records the completed agent click.
- **Watching is read-only.** Before taking control, snapshot the toolbar. Run `control-contingency browser snapshot --aria --path agent-view/takeover-watching.aria.txt`. `Go back`, `Go forward`, `Reload page`, and `Browser address` are all `[disabled]`, the address placeholder reads `Take control to drive the browser`, and the canvas `Live browser viewport` is `aria-readonly="true"`.
- **Take control.** Run `control-contingency browser click --role button --name "Take control"`, then `control-contingency browser wait --role button --name "Return control" --timeout-ms 15000`. The same toolbar handles are now enabled and the canvas is `aria-readonly="false"`.
- **Navigate by address.** Run `control-contingency browser fill --role textbox --name "Browser address" --value "${ECOMMERCE_URL%/*}/catalog.html"`, then `control-contingency browser press --key Enter --role textbox --name "Browser address"`. A bare host is completed to `https://`.
- **Navigate by history.** Run `control-contingency browser click --role button --name "Go back"`, then `control-contingency browser click --role button --name "Reload page"`. Each is dispatched one at a time; a second click while one is pending is refused by the disabled state rather than racing it.
- **Scroll the page.** Wheel events belong to the nested browser, not to Contingency chrome. Drive them with `computerUse` at the verification URL over the `Live browser viewport` canvas. The page under the canvas scrolls; the View behind it does not.
- **Proof (what the user did).** Read the session back with `control-contingency mcp call --tool agent_session_get --params "{\"sessionId\":\"$sessionId\"}"`. `currentUrl` is where the browser now is, and the timeline carries `The user took control`, `Navigate to <url>`, `Go back`, and `Reload the page`, each with `"actor":"user"` and `"outcome":"completed"`. Agent View shows the same entries under `Action timeline` attributed to `You`.
- **Proof (the view itself).** Run `control-contingency browser snapshot --aria --path agent-view/takeover-driving.aria.txt` and `control-contingency browser screenshot --path agent-view/takeover-driving.png`.
- **Return control.** Run `control-contingency browser click --role button --name "Return control"`, then `control-contingency browser wait --role button --name "Take control" --timeout-ms 15000`. The toolbar is disabled again and the timeline gains `The user returned control to the agent`.

### Teaching and the draft catalog

`mcp start` points the Agent Flow Catalog at `$CONTINGENCY_VERIFY_DIR/state/catalog`, so drafts never land in the repository's `.contingency`.

- **Select the Catalog Root.** Run `control-contingency mcp call --tool agent_catalog_select --params "{\"operationId\":\"verify-select-1\",\"root\":\"$CONTINGENCY_VERIFY_DIR/state/catalog\"}"`. Stdout reports that exact root. Repeating the same call returns the same result.
- **Start a Teaching session.** Same as above with `"activity":"teaching"` in the params. The snapshot carries `"teaching":{"actionCount":0,"draft":null,"instructionCount":0}`; a Run session carries `"teaching":null`.
- **Relay an instruction.** Run `control-contingency mcp call --tool agent_teaching_instruction_record --params "{\"sessionId\":\"$sessionId\",\"operationId\":\"verify-instr-1\",\"text\":\"Add the first product to the cart.\"}"`. The timeline gains `The user gave an instruction` and `instructionCount` becomes 1.
- **Demonstrate.** Take `agent_browser_snapshot`, then `agent_browser_act` a few times (fill the `Add by SKU` textbox with `ANVIL-001`, click `Add SKU to cart`, click `View cart`, `wait_for_text` `SKU ANVIL-001`). Every action, failed ones included, is captured with its actor and the Snapshot before and after.
- **Read the feed.** Call `agent_browser_screenshot`, then run `control-contingency mcp call --tool agent_teaching_feed_get --params "{\"sessionId\":\"$sessionId\",\"includeSnapshots\":true}"`. Stdout lists `instructions`, actor-attributed `actions`, `screenshots`, `snapshots`, `urlTransitions`, and `observedHosts` (`127.0.0.1` for the fixture). Known sensitive inputs in the screenshot are masked. Note the action `id`s for the next step.
- **Refused draft.** Save with a Domain Scope the Demonstration never visited: `control-contingency mcp call --tool agent_flow_draft_save --params "{\"sessionId\":\"$sessionId\",\"operationId\":\"verify-save-bad\",\"basedOnRevisionId\":null,\"draft\":{\"schemaVersion\":1,\"title\":\"Add an anvil to the cart\",\"description\":\"Add the anvil by SKU and confirm the cart lists it.\",\"domainScope\":{\"hosts\":[\"shop.example.com\"]},\"steps\":[{\"name\":\"Enter the SKU\",\"description\":\"Type the SKU and add it.\",\"confirmation\":false,\"firstActionId\":\"<fill id>\",\"lastActionId\":\"<add id>\"}]}}"`. Exit `2`; stdout names `unobserved_domain` and `uncovered_host` with their JSON paths and ends in `(agent_flow_invalid)`. `agent_catalog_get` still reports `"agentFlowCount":0`.
- **Saved draft.** Repeat with `"hosts":["127.0.0.1"]`, a fresh `operationId`, and two Steps whose spans are disjoint and in order. Stdout is the revision: `manifest.status` is `draft`, `heads.draftRevisionId` equals `manifest.revisionId`, and `path` is `…/state/catalog/agent-flows/<flow-id>/revisions/<rev-id>`. The directory holds `manifest.json`; `evidence/sha256-….json` beside `revisions/` holds one Evidence Slice per Step.
- **Proof (Agent View).** Run `control-contingency browser goto --url "$viewUrl"`, `control-contingency browser wait --role heading --name "Teaching" --timeout-ms 20000`, then `control-contingency browser snapshot --aria --path agent-view/teaching-draft.aria.txt` and `control-contingency browser screenshot --path agent-view/teaching-draft.png`. The `Teaching` region shows `Captured actions`, `Instructions`, the saved draft's Steps and Evidence hashes, and the Teaching Feed disclosure.
- **Proof (local Trace).** Close the Teaching session with `agent_session_close`, then require `test -s "$CONTINGENCY_VERIFY_DIR/state/catalog/teaching/$sessionId.trace.zip"`. The Trace stays under isolated state and is not copied into proof artifacts.
- **Proof (searchable later).** Run `control-contingency mcp stop`, `control-contingency mcp start`, then `control-contingency mcp call --tool agent_catalog_search --params "{\"query\":\"anvil\"}"`. `agent_sessions_get` is empty in the new process, yet the hit carries `"status":"draft"`, the title, `stepCount`, and `matchedFields`. `{"status":"approved"}` returns no hits.

### Teaching private Variables

- **Start on the login fixture.** Start a Teaching session at `${ECOMMERCE_URL%/*}/login.html`, open its `viewUrl`, and take control. Use `agent_browser_snapshot` first and note the refs for `Account ID`, `Password`, and `otp-input 1 of 6`.
- **Focus without entering the literal.** Before Takeover, call `agent_browser_act` with `{"action":{"type":"click","ref":"<account ref>"}}`. In Agent View click `Take control`, then click `Enter private value`.
- **Enter the reusable account in Agent View.** In the `Enter a private Variable` dialog fill `Variable name` with `ACCOUNT_ID`, fill `Value` with a disposable literal, leave `Secret` checked, leave `Ask during each Run` unchecked, and submit `Enter private value`. The dialog closes and the page receives the value once.
- **Enter agent-conversation values.** Return control. Call `agent_teaching_variable_input` for the password ref with `{"variable":{"name":"PASSWORD","secret":true,"runtime":false},"value":"<disposable password>"}` and for the first OTP ref with `{"variable":{"name":"OTP","secret":true,"runtime":true},"value":"<six-digit disposable otp>"}`. Use a fresh `operationId` for each. The OTP call completes only after all six one-character controls accept the value, and its returned Snapshot includes `Verification ready`.
- **Prove the feed boundary.** Call `agent_browser_screenshot`, then `agent_teaching_feed_get` with `includeSnapshots:true`. `variables` declares `ACCOUNT_ID`, `PASSWORD`, and `OTP`; the three captured fills contain `{{ACCOUNT_ID}}`, `{{PASSWORD}}`, and `{{OTP}}`. Search the complete stdout for all three disposable literals and require zero matches. Require the Snapshot to retain all six `otp-input N of 6` labels plus the unrelated `1800+` and `1940` copy. The screenshot masks the known fields on a best-effort basis; cookies, authorization data, network bodies, Trace, and video are absent.
- **Prove draft enforcement.** Try `agent_flow_draft_save` over the three fills without `variables`; it exits `2` with one `missing_variable` diagnostic per declaration. Retry with the feed's declarations. Read `manifest.json` and every Evidence Slice under the saved revision and require the disposable literals to be absent while the Step actions retain the three Variable references.
- **Proof (Agent View).** Capture `agent-view/private-variables.aria.txt` and `private-variables.png` while the private dialog is open. The proof shows the best-effort masking disclosure and the independent `Secret` / `Ask during each Run` controls, but never the Value literal.
- **Proof (local sensitive artifacts).** Close the session and require non-empty `$CONTINGENCY_VERIFY_DIR/state/catalog/teaching/$sessionId.trace.zip` plus a `.webm` file in the same directory. Read `$sessionId.artifacts.json`: it marks the named Trace and video with `"sensitive":true` and `"retention":"local"`. Do not copy the unredacted artifacts into `artifacts/`.

### Execution Boundary

- **Prepare verification.** Save a draft using the Teaching recipe above and mark its Step as a Confirmation Step. Open its Agent View and click the button `Authorize Verification Run`. Call `agent_flow_verification_start` with that exact `agentFlowId`, `revisionId`, client metadata, and a fresh operation id. Open the returned `viewUrl`.
- **Refuse a domain.** Call `agent_browser_act` with a navigate action whose URL replaces the fixture's `127.0.0.1` host with `localhost`. The result contains `intervention.reason: domain`; the browser stays on its previous page. Run `control-contingency browser wait --role heading --name "Waiting for confirmation"`. The region `Execution Boundary` shows the URL, action, operation id, `Allow host for this Run`, and `Refuse request`.
- **Take priority control.** Run `control-contingency browser click --role button --name "Take control"`. The boundary remains visible and its allow button becomes disabled. Click `Return control`, then `Refuse request`. Read `agent_session_get` again: `boundary` is null and the timeline retains the refusal.
- **Confirm one attempt.** Navigate to the approved fixture host, observe the page, and request a click on a current element reference. In a Confirmation Step this returns `intervention.reason: confirmation`. Click `Confirm this attempt`, then repeat the identical MCP operation id and action. It runs once. Replaying that id returns its original result; a new id requires another confirmation.
- **Request a new objective.** Supply `intent.objective` with an objective outside the approved Step. It returns `intervention.reason: objective`. Confirming this request permits only that action attempt. A marked irreversible action still requires its own confirmation.
- **Capture proof.** Save ARIA and screenshots under `agent-boundary/` while paused, during Takeover, and after confirmation. Re-read the session to prove the timeline and controller agree with the View. Approved Agent Flow Runs use the same controls.

## Gotchas

- `Loading Agent Sessions…` is transient. Wait for the alert or the empty heading. Do not snapshot the spinner.
- Unavailable copy is a destructive `alert`, not a heading. `getByRole` name matching is unreliable here; use `browser wait --role alert --has-text "Agent Session unavailable"`.
- Empty and unavailable are different. Empty means this MCP process is up and currently has zero sessions. Unavailable means this process is not an MCP owner, or the requested id is gone.
- `?session=` on web still shows unavailable. On MCP with other sessions, a bad id may show a more specific message (`…is not owned by this MCP process…`).
- Closing Agent View does not pause a real session. That sentence appears only on the live view, which this `web` launch cannot show.
- Do not start `mcp` on 7777 if the user already has Contingency there. `mcp start` picks its own port.
- Only the user returns control. There is no MCP tool for it by design; an agent may only ask with `agent_session_takeover_request`. A drive that needs the agent driving again must click `Return control`.
- Consecutive ordinary text edits during Takeover are coalesced into one semantic `fill`. Other low-level user input remains a redacted mouse or keyboard event.
- `agent_browser_screenshot` and `agent_browser_snapshot` keep working while the user holds control. Observation is not gated on control; action is.
- A failed tool call exits non-zero and prints the reason (`Element reference e12 is stale…`, `Could not find "X": Timeout…`). Assert on that text rather than on the exit code alone.
- Element references expire when the Page navigates. Take a fresh `agent_browser_snapshot` after any navigation before acting on a `ref`.
- Only `"activity":"teaching"` sessions carry a Demonstration. `agent_teaching_feed_get`, `agent_teaching_instruction_record`, and `agent_flow_draft_save` against a Run session exit `2` with `agent_session_invalid`.
- Domain Scope is judged against the hosts the compiled Steps visit, not every URL the session saw. Exploration outside every span neither widens nor is required in the scope.
- An instruction belongs to the Step whose span it falls before or inside. One given between two actions of the same Step lands in that Step's Evidence Slice, not the next one.
- A saved draft is not approved coverage. `agent_catalog_search` labels it `"status":"draft"`, and `{"status":"approved"}` stays empty until Agent View approves a revision, which this slice does not do.
