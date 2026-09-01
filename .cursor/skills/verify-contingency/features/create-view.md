# Create View

Create View is the default local UI: a live browser workspace beside Flow authoring. A user can name a Flow, pick or create a browser session, type a URL, and start a Recording once those are set.

## Sub-features

- `create-open` shows Create View as the current primary nav page.
- `create-workspace` shows the browser workspace chrome and the Flow authoring panel together.
- `create-title` accepts a Flow title in the authoring panel.
- `create-empty-recording` shows `No Recording yet` before capture starts.
- `create-start-disabled` keeps `Start Recording` disabled until a session, URL, and title are present.

## How to get to it (user POV)

- Open the verification URL (Create View is `/`).
- Choose the `Contingency` wordmark in the header.
- Choose the `Create` link in primary navigation.

## Driving it with control-contingency

Preconditions:

- Contingency is healthy at the verification URL.
- `control-contingency doctor` reports that URL and a disposable `stateDir`.
- This launch did not pass `--flow` (irrelevant to Create View, but Audit then starts empty).

- **Open Create View.** Load `/`. Run `control-contingency browser goto --path /`. The `Create` link is current and the heading `Flow authoring` is visible.
- **Confirm chrome.** Wait for the workspace. Run `control-contingency browser wait --role textbox --name "Browser address"` and `control-contingency browser wait --role button --name "Start Recording"`. The address field placeholder is `Enter a URL to start recording`. The empty browser heading is `Your browser will appear here`. The Steps empty copy is `No Recording yet`. The session control is a combobox named `Choose browser session`.
- **Set title.** Type a Flow name. Run `control-contingency browser fill --role textbox --name "Flow title" --value "Pharmacy"`. The textbox shows `Pharmacy`. `Start Recording` stays disabled because no session is selected and the address is empty.
- **Wordmark entry.** Leave Create View and return via the header. Run `control-contingency browser click --role link --name Audit`, then `control-contingency browser click --role link --name Contingency`. Create View is current again and `Pharmacy` remains in `Flow title` (client state for this page load).
- **Nav entry.** Choose `Create` after visiting Audit. Run `control-contingency browser click --role link --name Audit`, then `control-contingency browser click --role link --name Create`. The authoring heading is visible.
- **Proof.** Capture the filled title on Create View. Run `control-contingency browser snapshot --aria --path create-view/create.aria.txt` and `control-contingency browser screenshot --path create-view/create.png`. Both show Contingency, current `Create`, `Flow authoring`, `Pharmacy`, `No Recording yet`, and `Start Recording`.

## Gotchas

- `Start Recording` enabled is not the landing proof. Landing has no session; the button is disabled until a session, a URL, and a title exist.
- Creating a session (`Choose browser session` combobox, then create) launches a nested Chromium inside the CLI process. That is a real side effect. Do it only when the run needs a Recording or live page, and keep it on the isolated verify instance.
- Clicks on `Interactive browser viewport` hit a canvas, not the nested page's DOM. Do not treat canvas clicks as proof that a site control was used.
- Recording capture is a separate product path from opening Create View. An empty Steps panel is success for this feature.
