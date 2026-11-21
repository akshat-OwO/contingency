# Prototype review, 2026-11-20

Part of [#785](https://github.com/akshat-OwO/contingency/issues/785), step 5 of [#740](https://github.com/akshat-OwO/contingency/issues/740). The review compares the shipped Workspace with the approved #744 prototype, one seeded state at a time.

## Method

- **Build:** `main` at `d6db0e55`, CLI built with `vp exec turbo run build --filter=@contingencyhq/cli --force`.
- **Seed:** `control-contingency seed` on an isolated instance (`launch`, `ecommerce start`, `mcp start`). Every state comes from the real server: MCP operations through the broker, Workspace clicks through the driver, and Flow files in the isolated Catalog Root.
- **Capture:** `control-contingency seed capture --prototype http://127.0.0.1:4744/` at 1440 × 900, in light and dark, with an ARIA snapshot per state. The prototype ran from `docs/prototypes/744-workspace-design-direction` with its scaffold strip hidden.
- **Compare:** each prod capture was read beside its prototype capture, the approved `review/` PNG where one exists, and the prototype README. Four reviewers each took a group of surfaces. Every high-severity row, and a sample of the others, was rechecked by hand against the images and the source.
- **Scope:** the Workspace chrome around the page. The prod test shop and the prototype's sample store differ, so differences that come only from page content or data values are left out.

Evidence: `.cursor/skills/verify-contingency/artifacts/seed/<state>.{prod,prototype}-{light,dark}.png` and `<state>.{prod,prototype}.aria.txt`. Artifacts are not checked in; rerun `seed` and `seed capture` to regenerate them.

## Coverage

39 states were reached and 8 were not.

| Surface | Reached states |
| --- | --- |
| Workspace home | `home-empty`, `home-in-progress`, `home-start-web`, `home-start-android`, `home-start-ios` |
| Dock and Requests | `teaching-agent-preparing`, `teaching-ready`, `teaching-recording`, `run-live` |
| Request cards | `guided-question`, `run-execution-boundary`, `run-runtime-variables`, `dry-run-variables` |
| Teaching overlays | `teaching-comment`, `teaching-inspect`, `teaching-browser-check` |
| Interactive Run chrome | `teaching-bot-protection`, `guided-takeover-requested`, `guided-you-have-control` |
| Run details | `run-task-details-empty`, `run-task-details-long` |
| Run Summary | `run-ended`, `dry-run-passed`, `dry-run-review` |
| Flows page | `flows-catalog`, `flows-verified`, `flows-global`, `flows-run-completed`, `flows-run-failed`, `flows-run-closed` |
| App chrome | `chrome-theme-menu`, `chrome-not-found`, `chrome-unknown-session` |
| Web session canvas | `web-network`, `web-console`, `web-emulation`, `web-user-agent`, `web-storage`, `web-stream-diagnostics` |

| Unreached state | Why |
| --- | --- |
| `chrome-session-unavailable` | The `Agent Session unavailable` card shows only when a watched session's stream fails. |
| `chrome-loading` | The loader shows only until the session list answers, which takes milliseconds on a local server. |
| `dock-agent-idle` | `Agent idle for <n> min` needs ten minutes without an agent MCP call. |
| `dock-refused-gesture` | A refused gesture's alert is transient. |
| `teaching-demo-password` | The demo password asks only in a `contingency start --demo` work session. |
| `flows-hidden-interval` | A Hidden Interval comes from an Android secure screen. |
| `native-android`, `native-ios` | Native seeding was not built when the Web review ran. [Native states](#native-states) reviews them. |

## Patterns across surfaces

These causes repeat across many rows below. Fixing each once removes several rows.

| ID | Pattern | Rows it causes | Owner |
| --- | --- | --- | --- |
| X1 | In light, `--brand` resolves to the foreground color, so selected, open and pressed states lose the amber accent and turn grey or ink. Dark keeps amber. The active rail tool uses the blue `--ring` in both themes. | S25, S26, T13, T29 | `apps/web/src/styles.css:328`, `apps/web/src/components/browser/inspector-rail.tsx:38` |
| X2 | Geist Mono is never loaded and `--font-mono` is unset, so mono text falls back to the system stack. No rule sets font smoothing, so dark-theme text looks heavier. | H3, H4 | `apps/web/src/styles.css:196` |
| X3 | The shared `Input` adds a 3:1 border and `md:text-sm`, which overrides the `text-xs` callers set. DevTools, check-card, emulation and Takeover Variable fields render larger, heavier and outlined. The prototype uses filled fields. | T14, T25, T37 | `apps/web/src/components/ui/input.tsx:30` |
| X4 | The Flows link uses a book icon and Docs uses a question mark. In the prototype, Flows has a flow glyph and Docs has the book. | H5, D23 | `apps/web/src/components/catalog/flows-button.tsx:82`, `apps/web/src/components/docs-link.tsx:19` |
| X5 | Raw protocol ids and labels reach the UI. Recording ids appear as titles, other ids are cut in the middle, and labels such as "All checks passed", "Dry run passed" and "Not recording" appear. | S6, S8, S22, S27 | several, listed per row |
| X6 | The session status island collects extras that #753 left out: shortcut keycaps, **Rename flow**, a Browser Modifications summary, and a timer outside the chip. | D14, D16, D17, D19, S9, S19, T7, T9 | `apps/web/src/components/agent/teaching-recording-dock.tsx`, `run-dock.tsx` |
| X7 | Action tones are swapped. **Take control** is filled, **Stop** is destructive and **Start recording** is neutral. The prototype has them ghost, filled neutral and filled red. | D13, D15, D18, T6 | `teaching-recording-dock.tsx:392`, `run-dock.tsx:320` |

## Findings

Severity: **high** looks broken or contradicts an approved decision; **med** is noticeable drift; **low** is polish. IDs follow the reviewer groups: H for home and chrome, D for the dock and requests, T for overlays and the canvas, S for summaries and the Flows page.

### Workspace home

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| H1 | all home states | `link "Contingency home"` in the `Workspace` navigation | The home wordmark link is named "Contingency". The not-found page, through `AppIslands`, names it correctly | `agent/workspace-home.tsx:495` | high |
| H10 | `home-start-android` | Device is a Select plus a hint row | Native `<details>` triangle "▼ 1 stopped or unavailable device", a half-width device card with small Start and Erase buttons, and an indented ghost **Refresh devices** | `agent/device-choices.tsx:263`, `agent/android-start-card.tsx:195` | high |
| H17 | `home-start-android` | The card fits above the `Other platforms` pills | At 900px the card pushes the pills below the fold | `agent/android-start-card.tsx` | med |
| H11 | `home-start-android` | Target App search, an "or" divider and an always-visible .apk upload | Only "Choose a device to list its apps." No upload until a device is picked | `agent/android-start-card.tsx:330` | med |
| H12 | `home-start-ios` | Compact dashed dropzone: "Drop a .app here or browse" | Outline pill inside the dropzone, then a fixed 176px empty box. The card overflows the fold | `agent/target-app-upload.tsx:176`, `agent/ios-start-card.tsx:454` | med |
| H2 | all home states | Faint dashed frames with mono labels on the dot grid | Plain dot grid | `styles.css:98` | med |
| H7 | `home-in-progress` | Running chip with a progress ring and "4/9" | No mark on "Running" when no step is known | `agent/workspace-home.tsx:142` | med |
| H6 | `home-empty`, `home-in-progress` | 1, 2 and 3 key hints on the tiles | No key hints | `agent/workspace-home.tsx:598` | low |
| H8 | `home-in-progress` | `heading "In progress 7"` | `heading "In progress"`; the count is `aria-hidden` | `agent/workspace-home.tsx:629` | low |
| H9 | `home-start-*` | "Setup" at 14px, like the other labels | "Setup" at about 16px | `agent/start-card.tsx:131` | low |
| H13 | home tiles, start cards | Warm near-black ink | Neutral pure black, and neutral white in dark | `styles.css:291`, `agent/start-card.tsx:31` | low |

### App chrome

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| H14 | `chrome-unknown-session` | Alert on a tinted ground with neutral body text | White card with red title and red body text, which reads harshly | `ui/alert.tsx:17`, `agent/workspace-home.tsx:529` | low |
| H15 | docs | One card for "a session link that no longer resolves" | `features/workspace.md:98` says one card, while `:103` documents the home page with an alert for an unknown id. Both behaviors are intended; the wording at `:98` should name the lost-session case only | `.cursor/skills/verify-contingency/features/workspace.md:98` | low |

The theme menu and the not-found card match the prototype, apart from X2 and X4.

### Dock and status island

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| D5 | every recording state | No ring on the stage | A square 2px `red-500` ring around the stage column, clipped under the device bar and running behind the rail | `agent/agent-workspace.tsx:409` | high |
| D6 | `run-execution-boundary` | Status sentence "The agent is waiting on you…" | An empty, unnamed `button` inside `status`; no sentence | `agent/run-dock-state.ts:176`, `agent/workspace-dock.tsx:558` | high |
| D11 | states with an open request | Any open request turns the chip to "Needs you" | The chip keeps "Agent preparing", "Agent driving", "Rehearsing" or "Guided recording" while a card waits | `agent/run-dock-state.ts:189`, `agent/teaching-recording-state.ts:153` | med |
| D10 | `run-execution-boundary` | "Needs you" with a hand mark | "Waiting for you" with a circle-alert icon | `agent/agent-workspace-state.ts:310`, `agent/workspace-dock.tsx:484` | med |
| D12 | `teaching-ready` | "Ready" chip with a check | "Not recording" with a grey dot | `agent/teaching-recording-state.ts:165` | med |
| D13 | `teaching-ready` | **Start recording** filled red | Neutral filled button with a red dot (X7) | `agent/teaching-recording-dock.tsx:392` | med |
| D14 | `teaching-agent-preparing`, `teaching-ready` | Chip, sentence, tools, one action | An extra outlined **Rename flow**; while preparing it is the only action (X6) | `agent/teaching-recording-dock.tsx:361` | med |
| D15 | recording states | **Stop** filled neutral; Guided Runs read **Stop recording** | Destructive red **Stop** in both (X7) | `agent/teaching-recording-dock.tsx:392`, `agent/teaching-recording-state.ts:91` | med |
| D16 | recording states, `dry-run-passed` | Shortcuts only in tooltips | ⌘ ⇧ K keycaps inside the island, which stretch it (X6) | `agent/teaching-recording-dock.tsx:191` | med |
| D18 | Run states | **Take control** as a ghost button | Filled primary (X7) | `agent/run-dock.tsx:320` | med |
| D19 | `run-live` | Browser Modifications only in Task details | "1 mocked route · headers · 125% zoom" in the island, which cuts the sentence short (X6) | `agent/run-dock.tsx:286` | med |
| D17 | `teaching-recording` | "Recording 06:19", mm:ss inside the chip | Timer outside the chip in m:ss (X6) | `agent/teaching-recording-dock.tsx:327` | low |
| D20 | states with a sentence | `button "Status: <sentence>"` | `button "<sentence>"` | `agent/workspace-dock.tsx:560` | low |
| D21 | `teaching-agent-preparing` | Static progress ring | Spinning loader | `agent/workspace-dock.tsx:476` | low |
| T8 | `teaching-comment` | `button "Comment, 3 comments so far" [expanded]` | No expanded state while the dialog is open | `agent/teaching-recording-dock.tsx:171` | low |

### Request cards

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| D1 | `guided-question` | The card fits | **Reject check** and **Confirm check** are cut off at the island's bottom edge, with no sign that it scrolls | `agent/dock-requests.tsx:142` | high |
| D2 | `dry-run-variables` | One request at a time, then "+N more after this" | Two cards stacked in one island; only the first has a collapse button | `agent/dock-requests.tsx:139` | high |
| D8 | `run-execution-boundary` | Detail, then a mono target pill, then full-size **Refuse** and **Allow** | The target is plain text that wraps mid-word ("continuity.ht/ml"). A small **Allow** sits before **Refuse**, beside the URL | `agent/execution-boundary.tsx:123` | high |
| D7 | `run-execution-boundary` | "Execution Boundary" eyebrow, title "Allow the agent to visit a new host?" | No eyebrow; title "Allow a new domain" | `agent/execution-boundary.tsx:93`, `agent/dock-requests-state.ts:36` | med |
| D3 | `dry-run-variables`, `run-runtime-variables` | Eyebrow always "N of M needed" | Prerequisite and Runtime cards read "1 needed"; Setup and Dry Run cards read "1 of 1 needed" | `agent/dry-run-prerequisite-variables.tsx:130` | med |
| D9 | `run-execution-boundary` | No header controls | An **Action details** button that expands raw JSON; #776 replaced JSON with lists | `agent/execution-boundary.tsx:96` | low |
| D4 | `dry-run-variables` | Dry Run note "Values are visible in journey evidence." | The same text, which matches the prototype. It contradicts README:192 (masked; the agent never reads the value) | `agent/dry-run-variables.tsx:96` | low |
| D22 | request states, dark | Bare minus glyph | Minus in a filled tile | `agent/dock-requests.tsx:122` | low |

### Teaching overlays

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| T1 | `teaching-comment` | `heading "Comment at 00:43"` | The title is a fixed screen-reader-only "Comment"; the visible "Comment at 8:31" is `aria-hidden` | `agent/comment-card.tsx:426` | med |
| T2 | `teaching-comment` | Each comment has its own time | Both seeded comments read "0:00", though they were added seconds after Start. `elapsedLabel` floors any `at` at or before `startedAt` to 0. In one run the timer read 0:01 at capture, so the cause (comment time, timer start, or both) needs a repro | `agent/teaching-recording-state.ts:372` | med |
| T12 | `teaching-comment` | Activity, sparkles and database icons | Gauge, accessibility and cookie icons | `agent/teaching-comment-composer.tsx:102` | low |
| T15 | `teaching-browser-check` | Chip holds label, pill and × | An extra › chevron | `agent/browser-check-authoring.tsx:412` | low |
| T16 | `teaching-browser-check` | Values fit | The state select clips to "Created after the actio" | `agent/browser-check-authoring.tsx:165` | low |
| T17 | `teaching-browser-check` | "Remove attachment" at about 14px | Small button | `agent/browser-check-authoring.tsx:701` | low |
| T18 | `teaching-browser-check` | The check `region` is a sibling of the dialog | The region sits inside the dialog | `agent/comment-card.tsx:543` | low |

### Interactive Run chrome

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| T4 | `guided-you-have-control` | Amber ring around the page during Takeover | No Takeover ring; only the red recording ring (D5) | `agent/agent-workspace.tsx:396` | high |
| T10 | `guided-takeover-requested`, `guided-you-have-control` | **Task details** in the status island | Missing | `agent/teaching-recording-dock.tsx:354` | med |
| T11 | Guided states | Hand and pointer chip icons | Circle-alert and a plain dot | `agent/workspace-dock.tsx:484` | low |
| T19 | `teaching-bot-protection` | Close × at icon-sm; neutral shield badge in light | Smaller ×; amber badge in light | `agent/bot-protection-notice.tsx:39` | low |

### Run details

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| S18 | `run-task-details-long` | A finished sentence per modification | "Mock /cart-viewed: 204 text/plain," with a dangling comma when the body is empty | `packages/cli/src/services/browser-modifications.ts:154` | med |
| S16 | `run-task-details-*` | Small uppercase grey eyebrow "INTERACTIVE RUN" | Sentence-case, medium-weight foreground | `agent/run-dock.tsx:215`, `ui/popover.tsx:96` | med |
| S17 | `run-task-details-*` | 22px island radius | `rounded-lg` (10px) | `ui/popover.tsx:69` | med |
| S20 | `run-task-details-long` | `list "Findings"`, level 4 headings | Unnamed list, level 3 headings | `agent/task-run-details.tsx:324` | low |
| S21 | `run-task-details-*` | "Desktop 1280×800 · en-US" | "1280×800" | `agent/task-run-details.tsx:246` | low |

### Run Summary

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| S2 | `run-ended` | Chip **Ended**; sentence "This device session ended. Its Run is read-only." | Chip "Completed"; the sentence is the task title | `agent/agent-workspace-state.ts:316`, `agent/run-dock-state.ts:134` | high |
| S7 | `dry-run-passed` | Verify and Reject in `region "Flow decision"` at the foot of the dock | In the status island; no Flow decision region | `agent/teaching-recording-state.ts:293` | high |
| S10 | `dry-run-review` | The stage shows the Last frame beside the summary | An empty canvas: "The Dry Run's browser closed when it ended…" | `agent/dry-run-review.tsx:45` | high |
| S22 | `flows-catalog`, `dry-run-passed` | "Dry Run passed" | The same Run reads "All checks passed" on `/flow` and "Dry Run passed" in the dock | `agent/dry-run-summary.tsx:65` | high |
| S3 | `run-ended` | Dark "Last frame" chip centred over a rounded stage | Muted outline pill top left, outside the frame | `agent/agent-workspace.tsx:458` | med |
| S4 | `run-ended` | No device toolbar or tools rail on the ended stage | The disabled toolbar and rail stay | `browser/browser-device-bar.tsx:133`, `agent/workspace-browser-stage.tsx:399` | med |
| S5 | `run-ended` | **Done** filled | **Done** outlined | `agent/run-dock.tsx:303` | med |
| S6 | summaries | Short ids | Ids cut in the middle: "agentrun-b6e400b…7a6f2b0c" (X5) | `agent/evidence-reference.tsx:70` | med |
| S11 | `dry-run-review` | Two full-width buttons on a solid bar | Small buttons on an 85% translucent bar that shows the checklist through it | `agent/recording-view.tsx:227` | med |
| S13 | `dry-run-*` | Frame, caption bar, seek bar | Chapter label cut to "Before …", an extra file-path row, and a blank white poster in dark | `agent/run-video.tsx:783` | med |
| S8 | `dry-run-passed`, `flows-catalog` | "Dry Run passed" | "Dry run passed" (X5) | `agent/teaching-recording-state.ts:295`, `catalog/flows-format.ts:66` | low |
| S12 | `dry-run-review` | `Agent Session` combobox top left; blue review chip | `h1` "Dry Run review"; grey chip | `agent/dry-run-review.tsx:40` | low |
| S14 | summaries | "Agent Assessment", "No Takeover" | "Agent assessment", "No takeover" | `agent/dry-run-summary-state.ts:102` | low |
| S15 | summaries | `list "Checks"` | `list "Run checks"` (documented in `SKILL.md`; the prototype drifted) | `agent/dry-run-summary.tsx:573` | low |

S1, "video stuck on Preparing video", was capture timing. Watched in place, the docked video became playable without a reload. `seed capture` now waits for the player.

### Flows page

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| S27 | `flows-catalog`, `flows-run-closed` | Recording rows read "Cleaned up" with a "Recording" chip | The title is the raw 40-character recording id, with "Recording" or "Not recording" as phase text (X5) | `catalog/flows-page.tsx:1089`, `catalog/flows-format.ts:73` | high |
| S23 | `flows-*` | Platform icon per Flow in the tree | A generic document icon for every Flow | `catalog/flows-page.tsx:190` | med |
| S24 | `flows-catalog`, `flows-verified`, `flows-global` | Verified or Drafted, plus a platform chip | No platform chip; the global Flow's "Global" chip has a globe icon that reads as Web | `catalog/flows-page.tsx:545` | med |
| S25 | `flows-*`, light | Selected row tinted amber | Grey (X1) | `styles.css:328`, `ui/tree.tsx:74` | med |
| S28 | `flows-run-closed` | The Run list fits its rows | Capped at 34% height; the last row is sliced through its text | `catalog/flows-page.tsx:1046` | med |
| S29 | `flows-*` | Tinted outcome chip per Run; duration "1:36" | A dot and inline text; duration "2 seconds" | `catalog/flows-page.tsx:1063`, `catalog/flows-format.ts:11` | med |
| S26 | `flows-global`, light | Pressed **Global** solid | A faint tint (X1) | `catalog/flows-page.tsx:369` | low |
| S30 | `flows-*` | Counts in bordered pills; target icon on "Runs without one Flow" | Bare numbers; a play triangle that reads as a disclosure caret | `catalog/flows-page.tsx:363` | low |

### Web session canvas

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| T20 | `web-network`, `web-console`, `web-storage` | The page narrows to 912px beside DevTools | The page stays 1280px and scales to "Fit 60%", which makes its text hard to read | `agent/agent-workspace.tsx:349` | high |
| T21 | `web-network`, `web-console`, `web-storage` | `group "DevTools panels"` switches Console, Network and Storage in the header | A static title; no switcher | `browser/browser-devtools.tsx:974` | high |
| T5 | all canvas states | The page floats as a rounded, shadowed card | A bare square canvas | `agent/agent-workspace.tsx:439` | med |
| T22 | `web-network` | `table "Network requests"`; time as a duration | Plain divs; the row name "200 GETshop.html document" has no space; time is a wall clock | `browser/browser-devtools.tsx:865` | med |
| T29 | `web-*` | Active rail tool ringed in amber | Blue `--ring` tint (X1) | `browser/inspector-rail.tsx:38` | med |
| T30 | all canvas states | Live dot on Stream diagnostics | No dot | `agent/workspace-browser-stage.tsx:449` | med |
| T32 | `web-stream-diagnostics` | "Live · 30 fps" row with Reconnect; short labels | No state row; long labels wrap to 3–4 lines; "Waiting for frames" while a frame is on screen | `browser/browser-stream-diagnostics.tsx:59` | med |
| T33 | `web-user-agent` | `radiogroup` of five cards with descriptions | A long grouped `listbox` with checkmarks and no descriptions | `browser/user-agent-list.tsx:103` | med |
| T23 | `web-network` | — | "1 requests" | `browser/browser-devtools.tsx:914` | low |
| T24 | `web-network` | Path filter only | A ten-item Request type filter row | `browser/browser-devtools.tsx:808` | low |
| T26 | `web-storage` | Key and Value table | "HttpOnly" and "Secure" headers run together | `browser/browser-storage-panel.tsx:165` | low |
| T27 | `web-storage` | `radiogroup "Storage area"` | Unnamed `tablist`: "localStorage 0", "sessionStorage 0" | `browser/browser-storage-panel.tsx:86` | low |
| T28 | `web-console` | All, Warnings, Errors | All 0, Errors 0, Warnings 0, Logs | `browser/browser-devtools.tsx:484` | low |
| T31 | all canvas states | Rail about 16px from the edge | About 6px | `agent/workspace-browser-stage.tsx:980` | low |
| T34 | `web-emulation` | Field labels under the card `h2` | Section `h2`s nested in the card `h2` | `browser/emulation-panel.tsx:87` | low |
| T35 | all canvas states | `combobox "Device pixel ratio"`, `status "Viewport size"` | A 1×/2×/3× radiogroup; a lock button named with a full sentence | `browser/browser-device-bar.tsx:181` | low |
| T36 | all canvas states | Address field about 270px, legible | Narrower; the URL is cut mid-glyph | `agent/agent-workspace.tsx:576` | low |

## Native states

Added on 2026-11-21 with native seeding. The Method above applies, except for the following:

- **Devices:** Android ran on a Pixel_9 emulator (API 36) with the working checkout fixture `dev.contingency.checkout`. iOS ran on a disposable iPhone simulator (iOS 26.5) with `fixtures/ios-login`.
- **Seed and capture:** `seed --android --ios --only <the 23 native states>`, then `seed capture --prototype http://127.0.0.1:4744/ --path artifacts/seed-native`. Each platform's states form a chain on one device: Teaching, recording, comment, an agent Dry Run of the learned Flow, Takeover, the ended Run, and the start card.
- **Prototype counterparts:** `/s2` is the prototype's Android Dry Run, `/s3` its iOS Guided Run and `/s5` its ended iOS Dry Run. Teaching states start a new Teaching session from its start card: press 2 or 3, choose or upload an app, then **Start teaching**.

Evidence: `.cursor/skills/verify-contingency/artifacts/seed-native/<state>.{prod,prototype}-{light,dark}.png` and `<state>.{prod,prototype}.aria.txt`.

### Native coverage

23 states were reached and 2 were not.

| Surface | Reached states |
| --- | --- |
| Native Teaching | `android-teaching-ready`, `android-teaching-recording`, `android-comment`, `ios-teaching-ready`, `ios-teaching-recording`, `ios-comment`, `ios-field-variable` |
| Device rail | `android-device-settings`, `android-screen-elements`, `android-stream-diagnostics`, `ios-device-settings`, `ios-screen-elements`, `ios-stream-diagnostics` |
| Native Runs | `android-agent-driving`, `android-takeover`, `ios-agent-driving`, `ios-takeover` |
| Native Run Summary | `android-run-ended`, `android-run-summary-task`, `ios-run-ended`, `ios-run-summary-task` |
| Start cards with a device | `home-start-android-device`, `home-start-ios-device` |

| Unreached state | Why |
| --- | --- |
| `android-field-variable` | The Field Variable form opens only at a password field. The checkout fixture has none; `ios-field-variable` covers the form. |
| `ios-guided-question` | Guided Runs are browser-only. `agent_device_workspace` starts only Teaching sessions, Dry Runs and Runs. |

### Native findings

Severity and table format follow [Findings](#findings). Owner paths are under `apps/web/src/components/`. Where the prototype was still writing its summary when captured, the ended rows compare against the approved `review/778-summary-native-task-light.png` and the `/s5` summary.

These patterns from the Web review also apply to the native states: X1 for the active rail tool, X2 for mono text, X3 for Device settings fields, and X7 for Start recording.

| ID | State | Prototype | Prod | Owner | Sev |
| --- | --- | --- | --- | --- | --- |
| N1 | `android-run-ended` | Last frame and Run Summary, no alert | A red alert covers the top of the stage: "The Android session did not answer. Error: This Android session has ended, so there is nothing to observe. Read its Summary, or start a new session." The observe loop fails once the Run ends. Its follow-up read clears the failure only for `paused`, so an ended session reports it. iOS shows no alert | `agent/android-workspace.tsx:357` | high |
| N2 | `home-start-android-device` | Target App fits inside the card | The app search, the Installed apps list and the .apk dropzone run about 85px past the card's right edge. Long package names and build numbers sit outside the card, which runs below the fold at 900px (see H17) | `agent/android-start-card.tsx:305` | high |
| N3 | `*-run-ended`, `*-run-summary-task` | `article "Run Summary"` with a "Dry Run of <flow>" heading, Run video, a Duration, Actions, Findings and Evidence row, and a `tablist` of Pass checks, Findings and Task. Device facts sit in the Task tab | One flat column: the verdict, Agent Assessment, Video, a Screens list and the Device facts. It has no Flow title, no stats and no tabs, and nothing names the Flow the Dry Run tested | `agent/android-run-summary.tsx:683` | med |
| N4 | `*-agent-driving`, `*-takeover` | **Task details** beside the primary action | No **Task details** on native Runs. **Close session** sits in its place, which the prototype keeps out of the island (X6) | `agent/android-workspace.tsx:444`, `agent/ios-workspace.tsx:760` | med |
| N5 | `*-run-ended` | Chip "Ended", the line "The Run ended…", then **Task details** and **Done** | Chip "Dry Run failed", a status button that repeats the Agent Assessment, and **New session**. The Run was assessed inconclusive after Takeover; the chip states the stricter verdict that the summary already gives | `agent/teaching-recording-state.ts:123`, `agent/android-workspace.tsx:464` | med |
| N6 | `*-stream-diagnostics` | "Live · 60 fps", Device with OS version, Stream, Input to frame p95, Decode p95 and Decoded / dropped | Android reads "Waiting for frames" and "Frames shown 0" while the display shows frames, and its Device row is "Pixel_9" with no version. Both platforms lack the fps, latency, decode and dropped rows. T32 is the Web form of this finding | `agent/android-device.tsx:480` | med |
| N7 | `home-start-android-device` | `combobox "Device": Pixel_9 · Android 16`; `combobox "Target App"` | The device reads "Pixel_9 emulator-5554 · API 36". Installed apps are an always-open list of every package rather than a combobox | `agent/android-setup-state.ts:72`, `agent/android-start-card.tsx:290` | med |
| N8 | `android-run-ended` | The picker names the ended session: "profile · Dry Run" | The picker shows its placeholder "Android session" by design. iOS names the ended session ("seed-ios-… · iOS Dry Run") | `agent/android-workspace.tsx:776` | low |
| N9 | all native states | `combobox "Agent Session"` with a platform glyph | `combobox "Android Agent Session"` or `"iOS Agent Session"`, without the glyph | `agent/android-dock.tsx:240`, `agent/ios-workspace.tsx:639` | low |
| N10 | `*-teaching-recording`, `*-comment` | "Recording 00:00" | "Recording", no timer | `agent/android-dock.tsx:43`, `agent/ios-workspace.tsx:602` | low |
| N11 | `*-teaching-ready` | **Start recording** filled red | Filled neutral, with a dot icon (X7) | `agent/android-workspace.tsx:474`, `agent/ios-workspace.tsx:794` | low |
| N12 | `*-comment` | "Tap an element to attach it to the comment" | "Click an element…", on a touch device | `agent/android-device.tsx:701` | low |
| N13 | `*-screen-elements` | Group headings with counts: "Fields 3", "Controls 8" | "Fields", "Controls", with no counts. Each entry ends with a role word, as in "Shopper name field" | `agent/device-elements.tsx:114` | low |
| N14 | `android-device-settings`, `android-teaching-ready` | No badge until the user changes a setting. A `group "Location"` and the line "Applied to the emulator now. The Flow records them as Teaching evidence." | The Device settings rail button carries a "1" badge, and the card reads "Applied: 39.237255, -123.150032" for a location this session never set. The badge counts any location the emulator reports. Appearance and Location are `h3` sections with no helper line | `agent/android-device.tsx:281` | low |
| N15 | `*-run-ended` | A "Last frame" label inside the device region | A `figure` captioned "Last frame of the session, kept at <time>" below the frame, outside any named device region | `agent/android-run-summary.tsx:141` | low |
| N16 | all `ios-*` states | `navigation "Workspace"` first, then the device | `main "iOS Workspace"` puts the stage, or the ended frame, before the Workspace navigation. Android and the prototype put the navigation first | `agent/ios-workspace.tsx:1376` | low |
| N17 | `*-agent-driving` | "Running 4/9" with a step count | "Agent driving" with no progress (see H7). The status sentence also differs: "The agent is driving the emulator. Take control to act yourself." | `agent/android-dock-state.ts:247`, `agent/ios-dock-state.ts:227` | low |

These match the prototype: the agent's touch dot with its "Agent" label, the brand ring during Takeover, the rail on the right of the device, the comment card above the status island with "Earlier in this recording", the Field Variable card to the left of the iOS frame, and the Device fact list.

## Follow-up issues

One issue per surface with findings, under #740. Each takes its rows above and, where a pattern applies, the pattern row. The patterns X1–X3 get their own token issue, because fixing them changes every surface.

1. Design tokens: X1, X2, X3, X4.
2. Workspace home: H1, H2, H6–H13, H17.
3. Dock and status island: D5, D6, D10–D21, T8, X6, X7.
4. Request cards: D1–D4, D7–D9, D22.
5. Teaching overlays: T1, T2, T12, T15–T18.
6. Interactive Run chrome: T4, T10, T11, T19.
7. Run details: S16–S18, S20, S21.
8. Run Summary: S2–S8, S10–S15, S22.
9. Flows page: S23–S30, X5.
10. Web session canvas: T5, T20–T24, T26–T36.
11. App chrome: H14, H15.
12. Native states: N1–N17, with X7 for N11 and T32 for N6.
