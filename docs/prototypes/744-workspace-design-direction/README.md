# Prototype: Workspace design direction

Throwaway prototype for [#744](https://github.com/akshat-OwO/contingency/issues/744) and [#753](https://github.com/akshat-OwO/contingency/issues/753), part of [#740](https://github.com/akshat-OwO/contingency/issues/740). It is not production code and does not touch the Workspace route. #744 covered the Workspace home and the hand-off to a session. #753 splits the session dock into separate islands and adds the requests tier. Run Summary and the Flows Drawer come next.

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

## Run it

```bash
cd docs/prototypes/744-workspace-design-direction
vp dev --config vite.config.mjs
# open http://127.0.0.1:4744/
```

Run `vp install` at the repo root first, if you haven't already. View transitions need Chrome or Edge 111+ or Safari 18+.

The dark strip is prototype scaffolding, not proposed UI. It turns the running sessions on or off and cycles the theme. In a session it also moves the status island between corners (**Status**), queues the next sample request (**+ Request**), and shows a transient notice (**Notice**). On the home page, `1`, `2` and `3` open a platform, and Escape closes it.

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
