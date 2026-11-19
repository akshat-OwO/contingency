# Prototype: Workspace design direction

Throwaway prototype for [#744](https://github.com/akshat-OwO/contingency/issues/744), [#753](https://github.com/akshat-OwO/contingency/issues/753) and [#755](https://github.com/akshat-OwO/contingency/issues/755), [#757](https://github.com/akshat-OwO/contingency/issues/757), [#763](https://github.com/akshat-OwO/contingency/issues/763), [#764](https://github.com/akshat-OwO/contingency/issues/764), [#775](https://github.com/akshat-OwO/contingency/issues/775), [#776](https://github.com/akshat-OwO/contingency/issues/776), [#777](https://github.com/akshat-OwO/contingency/issues/777) and [#778](https://github.com/akshat-OwO/contingency/issues/778), part of [#740](https://github.com/akshat-OwO/contingency/issues/740). It is not production code and does not touch the Workspace route. #744 covered the Workspace home and the hand-off to a session. #753 splits the session dock into separate islands and adds the requests tier. #755 replaces the Flows Drawer with a Flows page at `/flow`, which also becomes the only place a Run Summary shows. #763 floats the Web session canvas: the page, its device bar, the tools rail and DevTools. #764 floats the Android and iOS session canvas: the device, its rail and its cards. #775 restyles the Teaching overlays: the comment card, its pins, the inspect hint, browser checks and the demo password. #776 restyles the request cards inside the Requests island. #777 restyles the Interactive Run chrome: the Guided Run control, the Takeover Variable and the bot-protection notice. #778 restyles the Run details: the sections inside the Run dock's Task details and the Run Summary's tabs.

It renders on `@ui-sdk/react` `0.1.0-beta.5`, the version the spike pinned (#742), and on the Workspace's own React. `vite.config.mjs` resolves both from `apps/web`, so the prototype installs nothing.

| Need | UI SDK part |
| --- | --- |
| Dock session switcher | Popover, opened from the `Agent Session` combobox trigger |
| Device, Simulator, Viewport, element roles | Select |
| Installed Target App | Combobox |
| `.apk` and `.app` builds | File Input |
| Starting data | Radio |
| Android permissions | Segmented Control |
| Setup section | Collapsible |
| Labels and hints | Field, Tooltip |
| Every button | Button |
| Flows page catalog | Tree, Collapsible (the global root), Input (search) |
| Flow files | Tabs |
| Run video seek bar | Slider |
| Run Summary sections | Tabs |
| Docked summary, decision bar | Button (no resizable panels) |
| Web canvas: Device, pixel ratio | Select (grouped presets) |
| Web canvas: User agent | Radio |
| Web canvas: Color scheme, streaming preference, Console level, storage area, request detail | Segmented Control |
| Web canvas: address, filters, Locale, Time zone | Input |
| Web canvas: rail and toolbar labels | Tooltip |
| Native canvas: Appearance | Segmented Control |
| Native canvas: Latitude, Longitude, Variable name, element filter | Input |
| Native canvas: rail labels | Tooltip |
| Erase confirmation | Alert Dialog |
| Teaching: scan and browser-check menus | Popover |
| Teaching: check purpose | Segmented Control |
| Teaching: response timing, cookie state, comparisons | Select |
| Teaching: check fields, demo password | Input |
| Teaching: comment tools | Tooltip |

## Run it

```bash
cd docs/prototypes/744-workspace-design-direction
vp dev --config vite.config.mjs
# open http://127.0.0.1:4744/
```

Run `vp install` at the repo root first, if you haven't already. View transitions need Chrome or Edge 111+ or Safari 18+.

The dark strip is prototype scaffolding, not proposed UI. It turns the running sessions on or off and cycles the theme. In a session it also moves the status island between corners (**Status**), queues the next sample request (**+ Request**), and shows a transient notice (**Notice**). **Sentence** switches the status sentence between short copy and the product's long copy, and **Full sentence** cycles how a clipped sentence is read: `popover` (chosen in the #754 review: the sentence is a button that opens it whole in a card above the status island), `tooltip`, or `none`. On the home page, `1`, `2` and `3` open a platform, and Escape closes it.

## Run details (#778)

Approved on #778. #757 and #760 restyled the Run Summary frame; this restyles the sections inside it and inside the Run dock's **Task details**. One component per section (`src/run-details.tsx`) serves both places.

| Section | Region | Holds |
| --- | --- | --- |
| Requested task | `Requested task` (`Intended outcome` on a Dry Run) | The task in a tinted block, the demo-store line, then `list "Changed instructions"`. |
| Referenced Flows | `Referenced flows` | One pill per Flow, linking to it on the Flows page, with an **Example** tag. Empty: "No Flows referenced." |
| Emulation | `Emulation` | Viewport, page zoom and text scale as a fact list, then `list "Emulation changes"`: the time, the change, and who made it. |
| Browser Modifications | `Browser Modifications` | **N active** beside the heading; one row per modification: time, what it does, **Saved with the Flow** or **Added by the agent**, and **Removed <time>** when it was. |
| Browser Checks (ADR 0056) | `Browser Checks` | **N of M required passed** beside the heading, red while any fails. One row per check: a pass, fail or open mark, the check id, its status word, the summary, then its Flow, attempt and time. |
| Required scans (ADR 0048) | `Required scans` | **N of M completed**, plus **coverage incomplete** in red. One row per requirement: mark, mode, status word, when (and until), destination, an out-of-scope note, the report summary, duration and **Download full report**. |
| System One Pursuits (ADR 0057) | `System One Pursuits` | **N delegated**; one row per Pursuit: goal, ending, reason, then `list "Model-chosen attempts"` with each attempt's confidences. |
| Agent Assessment | `Task assessment` | The outcome with its dot, the explanation and the evidence chips. Live: "Not submitted yet." |
| Findings | `Findings` | Live: "No findings yet." or the findings so far. |

**Where they show.**

- **Task details** (Run dock, live Web Run): task, Flows and setup first, then what it has recorded, then assessment and findings. It opens at 400px and scrolls inside.
- **Run Summary** (ended Run, Dry Run review, Flows page): **Checks** adds the evidence chips, **Browser Checks** and **Required scans** under the checklist. **Task** holds the task, **Referenced Flows**, **System One Pursuits**, **Browser Modifications**, **Emulation** and the execution outcome. **Findings** doesn't change.
- **Native Run** (ADR 0078): the browser sections never show. The Task tab holds the task, its Flows and a **Device** fact list (device, Target App, starting data, Takeover, capture gaps).
- **Ended-Run summary** (`ended-run-summary.tsx`): the #757 writing skeleton and the **Try again** missing state replace the plain loading line and the destructive alert.

**States.** Every section walks through empty (hidden, or one line when the section always shows), short and long. Statuses: a check is Passed, Failed, Inconclusive, Interrupted or Not evaluated; a scan is Completed, Partial, Failed, Running or Not run; a Pursuit is Done, Blocked, Unsure, Paused or Needs input.

Walk through it: the scaffold's **Details** cycles `seeded`, `empty`, `short` and `long`. Open **Find a red jacket under $80** → **Task details** (live Web Run). Open `/?session=ended:run_W8hs` (Web Dry Run) and look at **Pass checks** and **Task**, and `/?session=ended:run_N4cs` (iOS) for the native Task tab.

### Decisions

Approved on #778, as prototyped, including the native Device list:

- **One row style, no bordered cards.** Each section is an eyebrow heading, its count on the right, and a single outlined list of rows, like the Run Summary checklist. Today each check, scan and Pursuit is its own bordered card with a Badge.
- **Status words, not raw values.** **Passed**, **Partial**, **Needs input**, coloured by tone, replace the lowercase protocol values in Badges.
- **The summary's Task tab gains the setup sections.** Pursuits, Browser Modifications and Emulation reach the docked summary; today only the legacy Run view and Task details show them.
- **Native Runs get the Device list in the same style.** It touches `android-run-summary.tsx`, so prod adds the Android and iOS workspace proofs.
- **No Badge variant change.** The status words are text in the row; Badge isn't used, so it needs no new variant.

### Proposed contract changes (#778, approved)

| Kind | Today | Proposed |
| --- | --- | --- |
| Text | Browser Checks: "N/M required checks passed"; status is the raw value or "Unfulfilled"; first line "<flow> · <id>" | "N of M required passed"; **Passed**, **Failed**, **Inconclusive**, **Interrupted**, **Not evaluated**; the id leads and the Flow moves to the foot. |
| Text | Required scans: "N/M applicable scans completed · Scan coverage incomplete"; raw status Badge; "Not executed"; "Destination: <url>"; "Outside requested scope: …" | "N of M completed · coverage incomplete"; **Completed**, **Partial**, **Failed**, **Running**; **Not run**; the URL alone; "Outside the requested scope: …". |
| Text | Browser Modifications: "<time> · <text> · Agent · Saved / Agent-initiated · Removed <time>" | Time, text, then **Saved with the Flow** or **Added by the agent**, and **Removed <time>**. |
| Text | Pursuit ending as a raw Badge; attempts "<id> operation N%, target N%, value N%" | **Done**, **Blocked**, **Unsure**, **Paused**, **Needs input**; "<id> operation N% · target N% · value N%". |
| Text | Emulation: "Starting page zoom: N%. Text scale: N%."; changes "<time> · <actor>: page zoom a% → b%, text scale c% → d%" | A fact list (Viewport, Page zoom, Text scale); each change names only what changed and who. |
| Text | Live Task details: "No Agent Assessment submitted." | "Not submitted yet. The agent assesses the task when it finishes." and "No findings yet." |
| Role/name | Referenced flows are plain list items | Each is a `link` to `/flow?flow=<name>`. |
| Role/name | Run Summary Task tab: requested task, changed instructions, Flows, Execution | Adds `region "Referenced flows"`, `"System One Pursuits"`, `"Browser Modifications"` and `"Emulation"` on Web, and `region "Device"` on native. |
| Role/name | Ended-Run summary loading is a polite line; a missing summary is a destructive `alert` | The #757 skeleton with `status` "Writing the Run Summary…"; a missing summary keeps its `alert` and gains **Try again**. |

Every region and list name stays: `Requested task`, `Changed instructions`, `Referenced flows`, `Emulation`, `Emulation changes`, `Browser Modifications`, `Browser Modification activity`, `Browser Checks`, `Required scans`, `System One Pursuits`, `Model-chosen attempts`, `Task assessment`, `Findings`, `Browser evidence`, and the `Copy <kind> <id>` buttons. The #760 names (`Findings 0`, `Expand Run Summary: Summary <verdict>`) and the MCP `viewUrl` params don't change. The browser `AgentRunSummary` stays browser-only (ADR 0078). No ADR changes.

## Interactive Run chrome (#777)

Approved on #777. These pieces are Web-only: the Android and iOS docks have no Guided recording, Takeover Variable or bot-protection notice.

| Piece | Where | Holds |
| --- | --- | --- |
| Guided Run control | `Session status`, between the tools and **Stop recording** | One button: **Take control** while the agent drives, **Take over** (filled in the needs-you tone) after `agent_session_takeover_request`, **Return control** while you drive. While a change is pending it shows a spinner and keeps its name. |
| Takeover Variable | `region "Requests"`, as its own card, only while you hold control in a Guided recording | The #776 card layout: eyebrow **While you have control**, title, one line on what the Timeline and the saved Flow keep, then **Variable name**, **Variable value** and **Enter Variable**. Entered Variables fold into `list "Entered"` as **<NAME> entered**. |
| Bot-protection notice | The notices at the top centre | **<host> blocked this browser**, the provider and status, why the page and Flow are fine, and **Dismiss bot protection notice**. It stays until dismissed and sits above transient notices. |

**Status chip and sentence.** A Guided recording's chip reads **Guided recording <mm:ss>**, **Takeover requested** or **You have control**. The sentence says only what comes next, or why the agent asked (**The agent asked for help: <reason>**), because the chip already says who holds the browser.

**States.**

- **Control:** agent, requested, you. The control button is pending while a change is in flight. A failed change is an `alert` at the top centre: **<action> did not go through.**, followed by who still holds control.
- **Takeover Variable:** empty, filled, invalid (**Start with a capital letter. Use A–Z, 0–9 and \_.** under the name), submitting, error (**Could not enter the Variable. Focus the browser field and try again.**), entered.
- **Bot protection:** shown or dismissed.

Walk through it: open **signup · Guided Run**. In the scaffold, **Control** cycles agent, requested and you, **Control change** makes the next change fail, **Takeover Variable** forces the card's state (**live** lets you type; a value of `fail` fails), and **Bot block** shows the notice on any Web session.

### Decisions

Approved on #777, as prototyped:

- **Control stays one button** beside **Stop recording**, not a second primary. **Take over** gets the needs-you tone because the agent has stopped and is waiting.
- **A control error leaves the dock.** Today an always-present `alert` span sits inside the dock; a failure becomes a notice at the top centre, like every other refused gesture since #753.
- **The Takeover Variable is a request card** and collapses with the Requests island. Its value stays visible because the Timeline shows it.
- **The bot-protection notice is a toned island, not a destructive alert.** The site refused the browser; nothing is broken. It is the first notice to stop being destructive, which #753 carried forward.
- **Only the notice card takes input over the stream.** Today the notices column is a full-width block, up to 64rem wide, that takes pointer input. Now only the 480px card does, so Forwarded Input (ADR 0076) gets more of the frame back.

### Proposed contract changes (#777, approved)

| Kind | Today | Proposed |
| --- | --- | --- |
| Role/name | An empty `alert` always sits beside the control button | No alert until a change fails; then an `alert` at the top centre. |
| Role/name | Entered Takeover Variables leave no trace | `list "Entered"` with one item per Variable, **<NAME> entered**. |
| Role/name | An invalid Variable name relies on the browser's pattern bubble | The name field gets `aria-invalid` and a message under it. |
| Text | Guided status reads `<holder>. <reason>`, e.g. **The agent has control. Stop recording when finished.** | The chip names the holder; the sentence is the next step or the agent's reason. |

**Take control**, **Take over**, **Return control**, `region "Takeover Variable"`, **Variable name**, **Variable value**, **Enter Variable** and **Dismiss bot protection notice** stay. The MCP `viewUrl` params don't change. No ADR changes.

## Request cards (#776)

Approved on #776. The cards sit inside the Requests island #753 shipped; the island, its collapse and the Execution Boundary card don't change.

| Card | Region | Holds |
| --- | --- | --- |
| Variable card | `Setup Variables`, `Runtime Variables`, `Dry Run Variables`, `Prerequisite Variables`, `Example private inputs` | The count as the eyebrow (**2 of 3 needed**), the title, and one line on who sees the values. Then one field per waiting Variable: its name, its purpose when that says more than the name, the value, **Supply <name>** and, unless it is a Dry Run secret, **Refuse <name>**. Answered Variables fold into `list "Answered"` under the fields, as **<name> supplied** or **<name> refused**, never the value. |
| Guided Run questions | `Guided Run questions` (ADR 0065) | The open question at full weight. A free-text question has `textbox "Answer: <question>"` with **Send answer** (⌘↵). A proposed check shows its kind, reason and details as a short list, with **Reject check** and **Confirm check**. Answered questions settle under it in `list "Answered questions"`, each with its answer and who gave it. |

**One Variable layout.** Every Variable request uses the same card; only the title and the line under it change. Setup and Runtime fields show what you type. Prerequisite, Example and Dry Run values are private Variables the agent never reads, so their fields are masked with **Show <name>** / **Hide <name>**.

**States.** Each field and question walks through:

- **Empty:** **Supply** and **Send answer** are off.
- **Filled:** they turn on.
- **Invalid:** Enter on an empty field marks it and says "Enter a value, or refuse it." (or "Write an answer first.").
- **Submitting:** the field locks and the button reads **Supplying** or **Sending**; its name doesn't change.
- **Error:** an `alert` under the field. A failed Variable clears its value; a failed answer keeps its text.
- **Closed:** a question left open when recording stopped reads "Unanswered when recording stopped." (or "Unconfirmed …" for a check).

Walk through it: open **checkout**, press the scaffold's **+ Request** past the two boundaries (**Allow** each), and each press after that adds the next card: Setup, Dry Run, Prerequisite, Runtime, Example, a question and a proposed check. **Request state** forces every field into one state; **live** lets you type. In live mode, `fail` fails. **onboarding** (iOS Guided Run) opens on a question.

### Decisions

Approved on #776, as prototyped:

- **One Variable card** for all five Variable requests.
- **Private values are masked** while typed, with a reveal toggle. Today every field shows its value.
- **Who sees the value** is one line under the title, at every width. Today Setup and Dry Run show it only on wide islands.
- **Proposed checks** read as a list, not raw JSON.
- **No answer choices.** The #753 prototype offered choice buttons for a question; the protocol has only free text and check proposals, so they go.

### Proposed contract changes (#776, approved)

| Kind | Today | Proposed |
| --- | --- | --- |
| Role/name | Answered Variables are loose paragraphs | `list "Answered"` with one item per Variable: **<name> supplied** or **<name> refused**. |
| Role/name | Prerequisite, Example and Dry Run values are plain text fields | Password fields, plus **Show <name>** / **Hide <name>** toggle buttons. |
| Role/name | An empty value relies on the browser's `required` bubble | The field gets `aria-invalid` and a message under it. |
| Role/name | Answered questions read "Answered by user" or "User answer relayed by agent" | `list "Answered questions"`; each item ends with "you" or "relayed by the agent". |
| Role/name | A proposed check is a JSON `pre` | A short description list. |
| Text | "Values are visible in journey evidence" beside the collapse control on wide islands | One line under the title on every card, worded per Variable kind. |

**Supply <name>**, **Refuse <name>**, **Answer: <question>**, **Send answer**, **Confirm check**, **Reject check** and every region name stay. The MCP `viewUrl` params don't change. No ADR changes.

## Teaching overlays (#775)

Approved on #775. It follows the canvas direction approved on #763 and #764: chrome floats on the canvas, and nothing but pins, outlines and your input ring draws over the page or screen (ADR 0076).

| Island | Where | Holds |
| --- | --- | --- |
| Comment card, `dialog "Comment"` (non-modal) | Above the Session status island it opens from, clear of the tools rail. It follows the status island when **Status** moves it left. | **Comment at 00:42** and **Close comment**. Chips for the attached element (**Remove attached element**), the scan (**Remove scan**) and each browser check. The **Comment** field. Then **Attach element** (**Change element** once one is attached), and on Web **Performance scan**, **Accessibility scan** and **Browser check**, then **Add comment** (**Save comment** while editing). Under it, **Earlier in this recording**: every comment so far, newest first, with its time, its element or Page, its scan and checks, and **Edit comment <n>**. |
| Pins and outline | On the page or device screen | A numbered pin on each element a comment names. Pointing at a comment in the list outlines its element. They take no input. |
| Inspect hint | Top centre, where notices drop in | "Click (Tap on native) an element to attach it to the comment", with `Esc`. It takes no input and fades while the pointer is under it, so the element beneath can still be picked. Escape or **Attach element** again cancels. A pick that lands on nothing turns the hint into the error. |
| Browser check card, `region "<check>"` | Beside the comment card, opened from its chip; the chip's **Remove <check>** removes it, like the other chips | **Purpose for <check>**: Context for the agent or Must happen. A required check adds **When**, **Timeout**, the request (Method, Path, Origin, Query constraints, Response timing) or cookie (Name, State, Origin), **Array item path**, one row per predicate (**Field path <n>**, **Comparison <n>**, **Expected value <n>**, **Remove predicate <n>**), **Add predicate to this item**, whether Teaching observed it, and **Remove attachment**. |
| Demo password, `region "Teaching demo password"` | The Requests corner, which Teaching leaves free | Two steps, **Demo password** and **Enter demo password**. The recording keeps `DEMO_PASSWORD`. |

**One card on every platform.** Android and iOS use the same comment card, without scans and browser checks, which only a browser collects. They gain the list of earlier comments and pins on the screen.

**Shortcuts.** ⌘⇧K (Ctrl+Shift+K) opens the card, Enter adds, Shift+Enter breaks the line, Backspace in an empty field removes the element, Escape closes a check and then the card. The card shows them in tooltips and on **Add comment**, not in a footer.

Walk through it: open **checkout** (Web Teaching): **Comment** shows the three seeded comments and pin 2 on **Shop jackets**. Point at that comment to outline the button. **Attach element** and click a product, or click empty space to see the pick error. **Browser check** → **GET /api/cart from Network** opens its card; switch **Purpose** and add a predicate. **Performance scan** adds a scan chip. **Add comment** adds pin 4. Type `fail` and press Enter for the save error. The scaffold's **Demo password** shows the demo card; `wrongfield` shows its error. For native, start an Android or iOS session from home, **Start recording**, then **Comment** → **Attach element** and tap the screen.

### Decisions

Approved on #775, as prototyped:

- **Card position:** above the status island.
- **Browser checks:** each check is a chip in the comment with its own remove button; its editor opens as a card beside the comment.
- **Demo password:** in the Requests corner.
- **Native:** one card for every platform, replacing the native inline comment form.
- **Inspect hint:** takes no input and fades under the pointer; Escape or **Attach element** again cancels.
- **No explanatory subtexts** in the card, its menus or the check editor.

### Proposed contract changes (#775, approved)

| Kind | Today | Proposed |
| --- | --- | --- |
| Role/name | Web `dialog "Comment"` bottom left, with a shortcut footer | The same `dialog "Comment"` above the Session status island. Adds **Close comment**. The footer goes; its shortcuts move into tooltips. |
| Role/name | **Edit comment** on every earlier comment | **Edit comment <n>**, numbered like the pins, so each name is unique. |
| Role/name | **Require an unseen cookie** button and a drag hint in the card | **Require an unseen cookie** stays a tool button, now an icon beside the scans. The prototype's **Browser check** menu showed **GET … from Network**, but the product attaches requests by dragging them from DevTools, which still works; a menu with one item would add a press. The card, menus and check editor drop their explanatory subtexts. |
| Role/name | Each browser check is a `<details>` whose summary is its label, with native selects | A chip button named after the check that opens `region "<check>"`. **Purpose for <check>** becomes a radio group (Segmented Control). **Response timing**, **Storage check change** and **Comparison <n>** become UI SDK Selects (combobox). **Remove predicate** becomes **Remove predicate <n>**. Other field names stay. |
| Role/name | Native: `form "Comment"` in the dock with `textbox "Instruction"`, **Add** and **Detach <label>** | `dialog "Comment"` as on Web, with `textbox "Comment"`, **Add comment** and **Remove attached element**. Native gains **Earlier in this recording** and pins. |
| Role/name | Inspect: Web hint with **Cancel**; native picking text inside the composer | One top-centre status hint on both platforms, without a button: Escape or **Attach element** (pressed while picking) cancels. A missed pick is an `alert` in the hint. |
| Role/name | `region "Teaching demo password"` among the top notices | The same region in the Requests corner. **Demo password** and **Enter demo password** keep their names. |
| verify-contingency | `native-comment-proof.mjs` and `android-ui.mjs` fill `Instruction` and press **Add** | They use `Comment` and **Add comment**, and `features/workspace.md` names the card. |

The MCP `viewUrl` params don't change. No ADR changes; ADR 0048, 0056, 0076 and 0088 hold as written.

## Web session canvas (#763)

Approved on #763. A Web session lives at `/<session-id>` (for example `/s1`). The old `/?session=<id>`, which every MCP `viewUrl` already handed out uses, lands on `/<id>` without adding a history entry. An unknown id falls back to the home page. In the prototype, a native Run's ended device session is keyed `/ended:<run>`.

The page floats on the canvas at the viewport it emulates, and its chrome floats around it:

| Island | Where | Holds |
| --- | --- | --- |
| Device bar, `toolbar "Device controls"` | Top centre, between the Navigation and Actions islands, up to 720px wide and never under either | `group "Browser navigation"` (**Go back**, **Go forward**, **Reload page**, which becomes **Stop loading** while a page loads), the **Browser address** field, then **Device** (Responsive or a preset grouped as Phones, Tablets, Displays), the viewport size and zoom, **Rotate viewport** and **Device pixel ratio**. A narrow bar drops the size readout first. |
| Page, `region "Browser stage"` | The canvas between the islands | Responsive fills the space; a preset draws the page at its size and scales it down to fit, with the canvas around it. A load sweeps a brand bar along its top edge. |
| Tools rail, `navigation "Browser tools"` | Right edge, centred | **User agent** and **Emulation**, then **Console**, **Network** and **Storage**, then **Stream diagnostics**, with counts and a live dot. |
| Tool card | Beside the rail | **User agent**, **Emulation**, or **Stream diagnostics** (the streaming preference, the stream state with **Reconnect**, and the latency figures). Escape or a press on the page closes it. |
| DevTools | Right of the page (the page narrows) or under it (the page shortens) | Console, Network or Storage, switched in its header or from the rail. **Resize DevTools** drags or arrow-keys its size; **Dock to bottom** / **Dock to right** moves it. In Network, a request opens its detail (Response, Headers, Timing) under the list or beside it, sized by **Resize request details**. |

**Who drives.** While the agent drives a Run, the device bar, User agent, Emulation and Storage edits are locked with the reason, the address is read-only, and the agent's cursor (ADR 0046) moves over the page. A press on the page says to take control. During Takeover the page gets a brand ring and everything unlocks. While Teaching, your input lands with a ring where you pressed (ADR 0076).

**Stage states:** connecting (the Watcher loader, as `WatcherLoader` in `apps/web` draws it, over a blurred page), live, paused (**Reconnect**), and the last frame of an ended Run.

**Attach element.** **Comment** → **Attach element** turns the page into a picker: the element under the pointer is outlined with its role and name, a click attaches it to the comment as a chip, and Escape cancels.

**Motion.** Home → session still grows the start card or session card into the page. The device bar and rail rise in. A new viewport, opening DevTools, moving it and opening a tool card morph instead of jumping.

Walk through it: start a Web session from home (connecting, then live), open **checkout** (Teaching: type an address, go back and forward, pick iPhone 12 Pro and rotate, Comment → Attach element), and **Find a red jacket under $80** (Run: locked tools and the agent's cursor; open Network, select `/api/products?category=jackets`, resize its detail, dock DevTools to the bottom; Take control). The scaffold's **Stage** cycles live, connecting and paused.

### Proposed contract changes (#763, approved)

| Kind | Today | Proposed |
| --- | --- | --- |
| URL | A session at `/?session=<id>` | `/<session-id>`. `/?session=<id>` still lands on it, so MCP `viewUrl`s keep working. |
| Role/name | `group "Browser navigation"` and `textbox "Browser address"` in the browser toolbar above the page | The same names inside `toolbar "Device controls"`; **Reload page** reads **Stop loading** while a page loads. |
| Role/name | `toolbar "Device controls"` floating over the stage | A top-centre island with navigation, address and viewport controls. |
| Role/name | Network request detail: one view | `radiogroup "Request detail"` (Response, Headers, Timing) and `separator "Resize request details"`. |
| Behaviour | The inspector rail is a column fixed beside the stage; DevTools is a resizable panel in it | The rail floats on the right edge; DevTools is an island docked right or under the page. Names (`navigation "Browser tools"`, `Resize DevTools`, `Dock to bottom`, `Close DevTools`) stay. |
| Behaviour | A spinner while the browser connects | The Watcher loader. |

## Native session canvas (#764)

Approved on #764. It follows the Web canvas direction approved on #763: the device floats on the canvas, its chrome floats around it, and nothing but the agent's touch and your input ring draws over the screen (ADR 0076).

| Island | Where | Holds |
| --- | --- | --- |
| Device, `region "Android device"` or `region "iOS simulator"` | Centred on the canvas, at the size that fits | The frame and the live screen. Rotating turns the frame without zooming it. During Takeover the frame gets a brand ring. The screen keeps today's names (`Selected device live display…`, `Live iOS viewport…`). |
| Device rail, `navigation "Device controls"` | Beside the frame, on its right (ADR 0082) | **Android Back**, **Android Home**, **Android Recents** (iOS: **iOS Home**, **iOS App Switcher**), then **Rotate to landscape** and **Device settings**, then **Screen elements** and **Stream diagnostics**. Each one that drives the device is locked, with the reason, while the agent drives. |
| Card | Beside the rail, or at the canvas edge when the window is narrow | **Device settings**: Appearance (Light, Dark) and Location (Latitude, Longitude, **Apply**, **Use my location**, **Clear**). **Screen elements**: a filter, then Fields, Controls and Other elements as the accessibility tree reports them; hovering one outlines it on the screen, and choosing one taps its centre. **Stream diagnostics**: the stream state with **Reconnect**, the device, the stream, and input-to-frame and decode latency. Escape or a press on the screen closes it. |
| Field Variable, `form "Field Variable"` | Beside the frame, on its left | Opens when you tap a password field while you drive, on both platforms. **Enter <NAME>** for each supplied Variable, **Variable name** with **Request Variable**, and **Stop typing**. |

**Who drives.** While the agent drives, the device keys, Rotate, Device settings and Screen elements are locked with the reason, and the agent's touch (ADR 0046) shows where it taps: a dot labelled Agent, not a pointer. A press on the screen says to take control. During Takeover everything unlocks. While Teaching, your input lands with a ring where you pressed.

**Stage states:** connecting (the Watcher loader over a blurred screen), live, reconnecting, lost (**Reconnect device stream**, on iOS too), paused (Device disconnected), secure window (the screen goes black and says your input still reaches the device), and the last frame of an ended Run beside its docked summary.

**Attach element.** **Comment** → **Attach element** works on the device too: the element under the pointer is outlined with its role and name, a tap attaches it, and Escape cancels.

**Erase** stays on the start card (ADR 0081), now beside the Device field: **Erase <name>** opens `alertdialog "Erase <name>?"` with **Cancel** and **Erase device**. A device another session uses reads "Stop this device to erase it."

Walk through it: open **profile · Dry Run** (Android, the agent drives: locked rail, the agent's touch; **Take control**, then Screen elements, hover and choose one, tap **Password** for the Field Variable card, Device settings, Rotate), **onboarding · Guided Run** (iOS, waiting on a question), and start an Android or iOS session from home (Teaching: Comment → Attach element, Erase on the start card). The ended iOS **onboarding · Dry Run** shows the last frame. The scaffold's **Stage** cycles live, connecting, reconnecting, lost, paused and secure; **Rail** moves the rail between beside the frame and the window's right edge.

### Decisions

Approved on #764, as prototyped:

- **Rail placement:** beside the frame (ADR 0082). The scaffold's **Rail** shows the window-edge alternative that was not chosen.
- **Screen elements and Stream diagnostics** join the device rail. The Session status island keeps only status, Comment and the one action. ADR 0082 is updated to say the rail also holds these two tools.
- **The agent's touch on native** is drawn like the Web cursor (ADR 0046). ADR 0079 is updated; your own touches still show only as the input ring.
- **One Field Variable card on both platforms** replaces Android's "Type into <label>" form and iOS's dock form.

### Proposed contract changes (#764, approved)

| Kind | Today | Proposed |
| --- | --- | --- |
| Role/name | Android stage unnamed; iOS `main "iOS Workspace"` | `region "Android device"` / `region "iOS simulator"` around the frame. The screen's own names don't change. |
| Role/name | `navigation "Device controls"`: keys, Rotate, **Device settings** popover, beside the frame | The same landmark as an island, adding **Screen elements** and **Stream diagnostics**. **Device settings** opens a card (`region "Device settings"`); its Appearance, Latitude, Longitude, Apply, Use my location and Clear keep their names. |
| Role/name | **Screen elements** in the Session status island; a popover above the dock with a flat grouped list | On the rail. `region "Screen elements"` beside it with `textbox "Filter screen elements"`, Fields, Controls and Other elements; items keep **Select <label>** / **Activate <label>**. Hovering or focusing one outlines it on the screen. |
| Role/name | No stream diagnostics on native; **Reconnect device stream** on Android only | `region "Stream diagnostics"` on both platforms, and **Reconnect device stream** on iOS too. |
| Role/name | Android: a "Type into <label>" form in the Requests island with `combobox "Variable"`; iOS: `form "Field Variable"` in the dock | `form "Field Variable"` beside the frame on both platforms, with **Enter <NAME>**, **Variable name**, **Request Variable** and **Stop typing**. |
| Behaviour | No agent cursor or Teaching inspect on native | The agent's touch (`data-testid="agent-cursor"`) and **Attach element** on both platforms. ADR 0079 and 0046 updated. |
| Behaviour | Connecting is text only (iOS: a black canvas) | The Watcher loader. Secure window says input still reaches the device. |
| Behaviour | Erase on the start card's device list | Unchanged names, beside the Device field. |
| verify-contingency | `android-no-overlays` allows only **Android Back** outside the top bar and dock | Allows the whole `Device controls` rail and its cards, and features/workspace.md names the new regions. |

The MCP `viewUrl` params don't change.

## Run Summary (#757)

One summary component (`src/summary.tsx`) serves every surface, so they can't drift apart:

| Surface | Where | What's around it |
| --- | --- | --- |
| Ended session (ADR 0078) | `?session=<id>` once its Run ends, on Web, Android and iOS | The stage freezes on its **Last frame** and gives up its width to a full-height `complementary "Run Summary"` island on the right. The status island shows **Ended**, **Task details**, **Back to Teaching** when that session still runs, and **Done**, which closes the session. A Dry Run adds the decision bar under the summary. |
| Dry Run review (ADR 0073) | `?recording=<id>` | Same layout, with no live session: the last frame, the docked summary, and a **Dry Run review** status island with **Done** (back to the Flow on `/flow`). |
| Flows page (#755) | Runs pane | The same summary, inline. It stays read-only: a pending Dry Run links to its **Dry Run review**, and a native Run links to its ended **Device session**. |

The summary reads top to bottom:

1. **Verdict**: a tinted card, such as **Dry Run passed**, **Dry Run did not pass** (only Takeover or a partial attempt failed), **Dry Run failed**, or the Agent Assessment of an Interactive Run, with platform, kind and when.
2. Title, the reason it can't pass when that applies, and the agent's explanation.
3. The Run video (ADR 0046), with the seek bar's frame preview. A verified or purged Dry Run shows a note instead.
4. Four numbers: Duration, Actions, Findings, Evidence.
5. Tabs, so the video never moves: **Pass checks** (or **Checks**) with Browser Checks and Scan Reports, **Findings**, each with a timestamp that seeks the video, and **Task** with the requested task, changed instructions, the Flows used, Browser Modifications, Emulation and execution outcome.
6. The Run ID, copied with one click.

**Decision bar**, under a Dry Run's summary in the dock: **Reject flow** and **Verify flow** only when the Dry Run passed and the decision is pending. Otherwise it says why it can't be verified, that you rejected it, that you verified it (the video goes with Cleanup), or which files Cleanup kept, with **Retry cleanup**.

**Collapse** folds the dock into a **Summary** tool in the status island, which keeps the verdict in view; the stage takes the width back. Only collapse and expand morph the dock; leaving the view cross-fades it.

**States:** writing (skeleton and "Writing the Run Summary…"), missing (the summary wasn't written in time, with **Try again**), ready, and no Dry Run yet (review of a recording that has none).

Walk through it:

- **onboarding · Dry Run** (iOS) is already ended: a failed Dry Run that can't be verified.
- Open **wishlist · Dry Run** (Web), **profile · Dry Run** (Android) or **Find a red jacket under $80** (Web) and press **End Run** in the scaffold. The summary writes, then docks; profile offers Verify and Reject. Click a finding's timestamp to seek the video.
- `/?recording=rec_8Wl3` (wishlist on Web, passed with Browser Checks and a Scan Report, pending), `rec_5Pf0` (profile, passed, pending), `rec_3Vw8` (onboarding, failed), `rec_7Hc2` (checkout, verified and purged, with **Back to Teaching**), `rec_6Tz4` (settings, no Dry Run yet).
- On `/flow`: **profile** → the Dry Run → **Dry Run review**; **login** → **Device session**.

Scaffold: **End Run**, **Summary** (ready, writing, missing), **Decision** (pending, rejected, verified, cleanup-failed) and **Cleanup** (whether Verify ends in a Cleanup failure).

### Decisions

Approved on #757:

- **Native and global Runs on the Flows page** (carried over from #755): show their full summary inline, like browser Runs, plus a **Device session** link. The catalog summary alone was a dead end.
- **The `leading` slot** in `run-summary-sidebar.tsx` goes: the Flows page replaced its last caller. The dock has one side.
- **Resizing:** the dock has a fixed width (420px, 360px below 1280px) and collapses instead of resizing, so `react-resizable-panels` leaves with it.
- **Seek bar thumbnail:** the hover preview shows a frame, what happened, real Run time and span kind.
- **Flows page stays read-only:** Verify and Reject live only in the dock (ended Dry Run and review), never inline.

### Proposed contract changes (#757, approved)

| Kind | Today | Proposed |
| --- | --- | --- |
| Role/name | `complementary "Run Summary"` in a resizable panel with a resize handle (`Resize Run Summary`) | Same landmark and name, a floating island with no resize handle. **Collapse Run Summary** / **Expand Run Summary** keep their names; collapsed, **Expand Run Summary** is a button in `region "Session status"` with the verdict. |
| Role/name | Summary sections are `Verdict`, `Findings`, `Task` tabs | `tablist "Run Summary sections"`: **Pass checks** (Dry Run) or **Checks**, **Findings N**, **Task**. Findings carry `Show m:ss in the Run video` buttons. |
| Role/name | Dry Run review: status sentence and Verify/Reject above the summary | `region "Flow decision"` at the foot of the dock with **Verify flow** / **Reject flow**, or a status. **Retry cleanup** moves here from the dock. |
| Role/name | Run ID shown as text | Button `Copy Run ID <id>`. |
| Behaviour | Ended session: stage keeps live layout | The stage shows **Last frame** and the status island shows **Ended**, **Back to Teaching** or **Done**. |
| Behaviour | Native Runs on the Flows page show their catalog summary and a link | Full summary inline, and a **Device session** link. |
| Glossary | **Run Summary**: "…shown on the Flows page and beside an ended live session…" | "…beside an ended live session or a Dry Run review, docked in an island that collapses to its verdict…" |
| ADR 0078 | The Flows page shows a native Run's catalog summary | Shows its full summary, with a link to the ended device session. |

The MCP `viewUrl` params don't change: `?session=` and `?recording=` keep their meaning.

## Flows page (#755)

Approved on #755. **Flows** no longer opens a drawer. It goes to `/flow`, a page of its own, from the home page or any session, including one that is recording. Back returns to where you were. `/flow?flow=<name>&run=<id>` opens a Flow and one of its Runs directly (`global:<name>` for the user-global root), and the old Run Summary link, `/?run=<id>`, lands there too.

The page is three floating islands under the usual top chrome:

| Island | Holds |
| --- | --- |
| Catalog (left sidebar) | Search, then `contingency/` (Local) as a Group tree with each Flow's platform and Verified or Drafted mark, then **Runs without one Flow** (zero-Flow and multi-Flow Runs at the Catalog Root). The **Global** filter beside the heading shows `~/.contingency` (read-only) beneath it, with its Flows' Runs. Coming from a session marks that session's Flow **This session** and selects it. |
| Flow (middle) | The Flow's group path, its Verified or Drafted and platform chips, the values Contingency stamps (hosts or Target App, Emulation, Starting Data), then its markdown rendered, one tab per file. Procedure steps show their **Done when** outcome under each step, and a link to a supporting file opens its tab. |
| Runs (right) | The Flow's Runs and Teaching Recordings, newest first, each with its Agent Assessment. The selected one shows its Run Summary, the only one the Workspace has: the video, the assessment and explanation, findings, Browser Checks, Scan Reports, Browser Modifications, the Flows a multi-Flow Run used, and the Run ID. A Dry Run whose evidence Cleanup removed shows its summary without the video. |

The video follows ADR 0046: Action Windows play at real speed with the agent's cursor drawn in, Idle Gaps play condensed with a **Fast-forwarded** badge, a Takeover is marked **You had control**, and a native Hidden Interval shows **Hidden: secure screen**. The seek bar shows each span, hatched for Idle Gaps, and the clock counts real Run time. Hovering the seek bar shows a preview card: a frame of the video at that point, what happened there, the real Run time, and the kind of span.

Opening the page, the **Flows** button grows into the catalog sidebar, and the Flow and Runs panes follow it in. Leaving `/flow` by any route shrinks the sidebar back into the button.

Walk through it: from the home page, open **Flows**, then pick **checkout** (two files; a Run with Browser Checks and a Scan Report, a cleaned-up Dry Run with no video, and a Takeover), **login** (Android, Hidden Interval), **onboarding** (drafted from a Guided Run, a failing Dry Run), **settings** (drafted, no Runs), **Runs without one Flow**, and **Global** → **sign-in-sso**. Open a session first to see **This session**. The scaffold's **Catalog** switch shows the empty catalog.

### Decisions

Settled on #755:

- **While recording:** **Flows** stays available. The Workspace never blocks navigation, and someone blocked would type `/flow` anyway. The session keeps recording, and the switcher shows it as Recording.
- **Global Runs:** a global Flow's Runs are listed. The user-global root sits behind the **Global** filter.
- **Dry Run evidence:** once Cleanup removes a Dry Run's video, its summary drops the video block.
- **Run Summary:** the inline summary is the only one. The separate `?run=` view goes, and `/?run=<id>` lands on `/flow` with that Run selected.

## Session view (#753)

The single bottom dock is gone. A session spreads its chrome over four islands:

| Island | Where | Holds |
| --- | --- | --- |
| Navigation | Top left, where the home page has its brand | The **Contingency home** brand, then the `Agent Session` switcher. The switcher opens downwards. |
| Actions | Top right, the same island as on the home page | **Flows**, Docs, theme. |
| Session status | Bottom right (the scaffold can move it to bottom left; requests then take bottom right) | The status chip, the next-step sentence (hidden below 1280px), the tools for this activity (**Task details** on a task Run, **Comment** while Teaching), and the state's one action: **Start recording**, **Stop**, **Take control** or **Return control**. |
| Requests | Bottom left, opposite the status island, only while the agent waits on you | One request at a time with a `1 of N` count: Execution Boundary (Domain Scope or Confirmation) with **Refuse** and **Allow**, an input or a Dry Run secret with **Send**, or a Guided Run question with choices and **Send answer**. It collapses to a pill. During Takeover, **Allow** is disabled and **Refuse** stays available (ADR 0052). |

Transient notices, such as a refusal, a failed gesture or a saved recording, drop in at the top centre and let pointer input through.

Walk through it: open **Find a red jacket under $80** (boundary request, Task details, Take control and return), **login** on Android (use **+ Request** for a Confirmation, an input and a secret), **onboarding** on iOS (Guided Run question), and **checkout** or a new Teaching session (Comment, Stop, Start recording).

### Open questions

- **Status corner:** bottom right or bottom left.
- **Requests over the stage:** the requests island floats over the page or device instead of shrinking the stage, so the canvas never jumps. On a phone-shaped device it covers the bottom of the screen.
- **Narrow windows:** below 1280px the status island hides its sentence and its tool labels so the requests island keeps its width.

## Direction

- **Floating islands on a canvas background.** Every piece of chrome is a rounded, translucent island with a soft shadow. Nothing drifts or bobs. The background is a static dot grid with faint dashed frames on it. You can't interact with it.
- **Every platform starts the same way.** Web, Android and iOS are three equal tiles with their icons. A tile grows into one start card with the same three numbered sections on every platform:
  1. Flow name, and the Viewport, Device or Simulator.
  2. What it opens: a starting page on Web; an installed app or an uploaded `.apk` on Android; an uploaded `.app` on iOS.
  3. **Setup**, collapsed by default. On Web it holds the browser profile: clean by default, or imported from an installed browser. On Android and iOS it holds starting data, Starting screen and Done when, plus app permissions on Android.

  **Start teaching** stays disabled until every required field is filled. Switching platform swaps the card's contents in place, keeps the Flow name, and doesn't fly the icons around.

- **Sessions in progress.** The **In progress** shelf is the home page's only session list, and it appears only when a session is running. The `Agent Session` switcher lives only in a session's top-left island, and adds a **New session** button that goes home. A status shows as a tinted chip with its own mark, and none of them pulse:
  - Recording: a record mark and the elapsed time.
  - Running: a progress ring and the step count, such as `4/9`.
  - Needs you: a hand.
  - Ready: a check.
- **The logo and the switcher travel.** In a session, the wordmark and the shelf's "In progress" heading fly into the top-left island as the brand and session switcher, and the card you clicked grows into the stage. Going home reverses it.
- **Desktop only.** Below 1024px wide, the Workspace is replaced by a notice that asks you to open it on a desktop.
- With reduced motion turned on, the transition and hover motion are off. With reduced transparency turned on, the islands go solid.

## Proposed contract changes

### Flows page (#755, approved)

| Kind | Today | Proposed |
| --- | --- | --- |
| Route | No route. The Flows Drawer opens over the current view | New route `/flow`, with optional `?flow=<name>` (or `global:<name>`) and `?run=<id>`. |
| Route | `/?run=<id>` opens the Run Summary view, and the MCP `open_run` tool returns it as its `viewUrl` | The view is removed. `/?run=<id>` redirects to `/flow?flow=<its Flow>&run=<id>`, so existing links keep working; `open_run` may return the new URL. The other `viewUrl` params don't change. |
| Role/name | **Flows** button opens a dialog (the drawer) | **Flows** is a `link` named `Flows, <count>` to `/flow`, and carries `aria-current="page"` there. It is no longer disabled while recording. |
| Role/name | Drawer with a `tree` per Catalog Root (`local Flow Groups`, `global Flow Groups`) and a details panel beside the browser | `complementary "Catalog"` with `tree "Local Flows"`, a toggle button **Global** that adds `tree "Global Flows"`, a `textbox "Search Flows"` and a **Runs without one Flow** button. Beside it, `region` named after the Flow (its markdown, `tablist "Flow files"`) and `region "Runs"` (`list "Runs and recordings"`, `region "Run Summary"`; a Teaching Recording is `article "Teaching Recording"`). |
| Behaviour | Flow details show the procedure as a list and files as highlighted source | Every file renders as markdown. **Done when** shows beneath its step. |
| Behaviour | A Run's details link out to **Open Run Summary** in a new tab | The Run Summary, with its video, Browser Checks, Scan Reports and Browser Modifications, shows inline in the Runs pane. There is no separate view. A cleaned-up Dry Run shows no video. |
| Glossary | **Flows Drawer**: "the Workspace's read-only browser over Catalog Roots… opened from the Flows button…" | Renamed **Flows page**: the Workspace page at `/flow`, opened from the Flows button. The rest of the definition stands: read-only, local root first and global beneath it behind a **Global** filter, Runs grouped under their Flow, zero-Flow and multi-Flow Runs at the root, the session's own Flow marked, never visible to an agent. |
| Glossary | **Workspace**: "…Flows at the top right…" | "…Flows at the top right, which opens the Flows page…" |
| ADR 0051 | The user-global catalog is listed in the Flows Drawer | Listed on the Flows page behind the **Global** filter, with its Runs. The ADR's read-only and user-only rules stand. |
| Glossary | **Run Summary**: "The local Workspace report of a Run…" | "…shown in the Runs pane of the Flows page." |

### Session view (#753, approved)

Approved on #753. The open questions above were accepted as prototyped.

| Kind | Today | Proposed |
| --- | --- | --- |
| Role/name | One region "Workspace dock" holds the logo mark, the `Agent Session` combobox, the state, the tools, the action and the requests tier | Removed. Its contents move to the islands below. `verify-contingency` scripts that scope to "Workspace dock" (`android-ui.mjs`, `control-contingency` and the `*-proof.mjs` scripts) scope to the new regions instead. |
| Role/name | Logo mark and `Agent Session` combobox inside the dock | Both sit in the top-left navigation "Workspace", the same landmark as on the home page. The link is named "Contingency home". The combobox keeps its role and name; its popover opens downwards. |
| Role/name | Status line and controls row inside the dock | New region "Session status": the status chip, the next-step sentence, **Task details** (every Run, not only task Runs) or **Comment** (Teaching), and the one action (**Start recording**, **Stop**, **Take control**, **Return control**). |
| Role/name | Requests tier above the dock's status line, with **Collapse requests** and a "Show request: …" button | New region "Requests" in the bottom-left corner, only while the agent waits. It keeps **Collapse requests** and "Show request: …", and shows one request at a time with a `1 of N` count. Allow and Refuse keep their names. |
| Role/name | Refusals and failures as `DockNotice` alerts above the dock | Notices are status messages at the top centre, with a success, error or info tone. They still pass pointer input through. |
| Role/name | **Flows** button in the dock | Removed from the session's bottom chrome. **Flows** lives in the top-right island in every view, as on the home page. |
| Behaviour | The stage reserves the dock's height, including the requests tier | The stage reserves only the bottom row. The requests island floats over the page or device, so the canvas never resizes when a request comes or goes. ADR 0076 forwarding is unchanged outside the islands. |
| Behaviour | During Takeover, **Allow** is disabled and **Refuse** is available (ADR 0052) | Unchanged. The request explains "Return control to allow". |
| Glossary | **Workspace**: "an open session's live browser under a floating dock that carries the Teaching state and the one action that state offers" | "…under floating islands: navigation and the session switcher top left, actions top right, the session status and its one action in a bottom corner, and requests opposite it." |
| Glossary | **Workspace home**: "Every session dock carries the **Contingency home** mark back to it, and the dock's session picker offers **New session**." | "Every session's navigation carries…, and its session picker offers **New session**." |
| ADR 0051 / Glossary | **Flows Drawer** opens "from the Workspace home's Flows button or the dock's" | Opens from the **Flows** button in the top-right island, in every view. |

### Workspace home (#744, approved)

| Kind | Today | Proposed |
| --- | --- | --- |
| Role/name | Empty state `h1` "No browser session" with a Flow name field and an **Open browser session** button (Web only) | `h1` "Teach a new Flow" and a list "Start a session" with three buttons, "Start a Web/Android/iOS session". Each opens a form "Teach on …" with **Flow name**, a device select, a target, a **Setup** collapsible and **Start teaching**. |
| Role/name | `Workspace platform` toggle group (Web / Android / iOS) | Removed. The platform tiles and the "Other platforms" group replace it. |
| Role/name | None | New region "In progress" with one button per Agent Session, named like the switcher's options. |
| Role/name | None | New alert "Open Contingency on a desktop" below 1024px. The rest of the Workspace isn't rendered there. Approved. |
| Behaviour | **New Android session** and **New iOS session** setup Sheets, opened from the platform switcher | Approved: the start card replaces both Sheets. It keeps their fields (Device, Target App, permissions, starting data, Starting screen, Done when) and drops the Sheet. The "Prepare and open app?" confirmation stays. ADR 0076 forwarding is unchanged. |
| Behaviour | Web asks only for a Flow name, and every browser session starts with a clean profile | Web adds a starting page. **Setup** shows the clean profile as the default, with an **Import profile…** button that lists the browser profiles installed on the machine (Chrome, Arc, Edge and so on). An imported profile's cookies and storage are copied into that session only. Agents can already do this setup through Browser Modifications; the start card puts it in front of the user. It ships in #748. The CLI doesn't accept a starting URL yet, so #744 adds it. |
| Glossary | **Workspace**: "the live browser under a floating dock" | Add a **Workspace home**: the start surface for all platforms, with the sessions in progress. |
| Glossary | **Workspace dock** | The dock carries the logo mark (as **Contingency home**) and the session switcher in every session, on all three platforms. |
| ADR 0051 | The Flows Drawer opens from the dock's **Flows** button | **Flows** also sits in the top-right island on the home page. The drawer itself comes in a later pass. |

The MCP `viewUrl` params do not change. `?session=` opens a session view directly, without the home page. On a narrow screen, it shows the desktop notice instead.
