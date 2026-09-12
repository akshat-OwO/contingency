# Create View

Historical recipe. Its Create and Audit routes were removed in #170. Use [Workspace](./workspace.md) for current UI verification. The deterministic CLI remains until #165 Phase 6.

Create View is the default local UI: a live browser workspace beside Flow authoring. A user can name a Flow, pick or create a browser session, type a URL, start a Recording, and see captured Steps appear in the authoring panel.

## Sub-features

- `create-open` shows Create View as the current primary nav page.
- `create-workspace` shows the browser workspace chrome and the Flow authoring panel together.
- `create-title` accepts a Flow title in the authoring panel.
- `create-empty-recording` shows `No Recording yet` before capture starts.
- `create-start-disabled` keeps `Start Recording` disabled until a session, URL, and title are present.
- `create-session` creates a nested Chromium session from the session combobox.
- `create-address` navigates the session to a URL from the address bar.
- `create-start-enabled` enables `Start Recording` once session, URL, and title are set.
- `create-recording-active` starts a Recording and shows at least one Step with Pause / Finish controls.
- `create-session-switch` switches between two browser sessions from the session combobox.
- `create-finish-download` finishes a Recording and downloads the Flow JSON.

## How to get to it (user POV)

- Open the verification URL (Create View is `/`).
- Choose the `Contingency` wordmark in the header.
- Choose the `Create` link in primary navigation.

## Driving it with control-contingency

Preconditions:

- Contingency is healthy at the verification URL.
- `control-contingency doctor` reports that URL and a disposable `stateDir`.
- For ecommerce browsing and recording, `control-contingency ecommerce start` has printed `ecommerce=` and nested actions use `computerUse` (see `ecommerce-drive.md`).

- **Open Create View.** Load `/`. Run `control-contingency browser goto --path /`. The `Create` link is current and the heading `Flow authoring` is visible.
- **Confirm chrome.** Wait for the workspace. Run `control-contingency browser wait --role textbox --name "Browser address"` and `control-contingency browser wait --role button --name "Start Recording"`. The address field placeholder is `Enter a URL to start recording`. The empty browser heading is `Your browser will appear here`. The Steps empty copy is `No Recording yet`. The session control is a combobox named `Choose browser session`.
- **Set title.** Type a Flow name. Run `control-contingency browser fill --role textbox --name "Flow title" --value "Pharmacy"`. The textbox shows `Pharmacy`. `Start Recording` stays disabled because no session is selected and the address is empty.
- **Create session.** Open the session combobox and create an isolated session. Run `control-contingency browser click --role combobox --name "Choose browser session"`, then `control-contingency browser fill --role combobox --name "Search or create a session..." --value "verify"`, then `control-contingency browser click --role option --name 'Create session “create-verify”'`. After the stream connects, the combobox label becomes `Browser session: create-verify`.
- **Navigate session.** Submit a URL for that session. Run `control-contingency browser click --role textbox --name "Browser address"`, then `control-contingency browser fill --role textbox --name "Browser address" --value "https://example.com"`, then `control-contingency browser press --key Enter --role textbox --name "Browser address"`. The address field shows `https://example.com/`.
- **Start Recording.** With session, URL, and title set, start capture. Run `control-contingency browser fill --role textbox --name "Flow title" --value "Pharmacy"` if needed, then `control-contingency browser click --role button --name "Start Recording"`. Status shows `active`, the Steps badge is at least `1 Steps`, and `Pause` / `Finish` are visible. `Record a hover` is available for explicit hover capture.
- **Wordmark entry.** Leave Create View and return via the header. Run `control-contingency browser click --role link --name Audit`, then `control-contingency browser click --role link --name Contingency`. Create View is current again and `Pharmacy` remains in `Flow title` (client state for this page load).
- **Nav entry.** Choose `Create` after visiting Audit. Run `control-contingency browser click --role link --name Audit`, then `control-contingency browser click --role link --name Create`. The authoring heading is visible.
- **Proof (landing).** Capture the filled title before Recording. Run `control-contingency browser snapshot --aria --path create-view/landing.aria.txt` and `control-contingency browser screenshot --path create-view/landing.png`. Both show Contingency, current `Create`, `Flow authoring`, `Pharmacy`, `No Recording yet`, and disabled `Start Recording`.
- **Proof (recording).** After `Start Recording`, capture the active state. Run `control-contingency browser snapshot --aria --path create-view/recording.aria.txt` and `control-contingency browser screenshot --path create-view/recording.png`. Both show `active`, at least `1 Steps`, and `Pause`.
- **Switch sessions.** With two sessions created, open the session combobox and select the first session, then the second. The combobox label updates to the selected session id.
- **Finish and download.** After Recording, click `Finish`, then `control-contingency browser download --role button --name ".json" --partial --path create-view/downloaded-flow.json`.
- **Full ecommerce path.** For browse → session switch → record SKU → cart → audit replay, follow `ecommerce-drive.md` instead of duplicating steps here.

## Gotchas

- `Start Recording` enabled is not the landing proof. Landing has no session; the button is disabled until a session, a URL, and a title exist.
- Creating a session (`Choose browser session` combobox, then create) launches a nested Chromium inside the CLI process. That is a real side effect. Do it only when the run needs a Recording or live page, and keep it on the isolated verify instance.
- The session combobox is named `Choose browser session` only while none is selected. After selection it becomes `Browser session: {id}`.
- Filling `Browser address` alone does not navigate. Submit with `browser press --key Enter --role textbox --name "Browser address"` (or an equivalent user submit) so the URL reaches workspace state.
- Clicks on `Interactive browser viewport` hit a canvas, not the nested page's DOM. Drive nested ecommerce pages with `computerUse`; use `Record a hover` for explicit hover Steps in Contingency chrome.
- `Loading…` and `Connecting to the browser stream...` are transient between session creation and canvas readiness. Wait for the session label or address field to settle before starting a Recording.
- A full-page screenshot immediately after `Start Recording` can fail while the browser stream is still attaching. Wait for `1 Steps` or `Pause` before capturing `recording.png`.
