---
status: accepted
---

# Browser actions respect foreground interception

A Snapshot describes rendered controls, including controls covered by a foreground sheet. Covered controls carry `blockedBy` with the blocking element's role and name, and the text representation omits their action reference. Reachable viewport controls take priority over covered controls within the Snapshot budget. Unnamed controls retain their references and viewport bounds, so the agent can compare them with a screenshot without inventing an accessible name.

Before element input, Contingency scrolls the target into view and samples points within its viewport intersection. A point is reachable only when Chromium's hit test returns the target or one of its descendants. Click and hover use that point through Playwright's ordinary actionability checks. No force click or DOM event dispatch bypasses the foreground element. A partly covered target can still be used at a reachable edge.

Typing checks reachability, focuses the control without clicking it, and rechecks it, so a modal opened on focus can prevent text from being sent. Selection and private entry also check reachability. Targeted keys focus without activation. Keyboard checks never scroll the page and preserve hidden or offscreen focus targets; visible covered controls still refuse input. Escape and keyboard traversal remain available for recovery. Covered inputs are not focused through the overlay merely to draw the agent pointer.

Associated labels count as reachable controls. When a label owns the pointer hit, a normal Playwright click targets that label and lets the browser activate its control. Hit testing descends into open shadow roots instead of mistaking their hosts for overlays. Click and hover retain the normal ten-second actionability budget; the one-second pointer budget applies only to the courtesy cursor.

An intercepted action returns `reason: intercepted` with instructions to reread the Snapshot, choose a foreground dismissal control, and use a screenshot with unnamed-control bounds if necessary. An agent should not repeat the unchanged blocked action or assume Escape dismissed a sheet. Dismissal is a normal observed website action; Contingency neither removes overlays nor reloads a page automatically.

React click handlers, native listeners, image alternatives, and pointer cursor roots remain the sources for discovering scripted controls. Modal ARIA is a naming clue, not a prerequisite for detecting interception. The hostile ecommerce fixture covers stacked sheets, an unnamed close image, a React-style div containing a named close image, and a modal that appears during focus. The fixture and verification recipe live under `verify-contingency`.

The sequence tool uses the same catalog deduplication as #381: its result is encoded with the complete protocol schema, without republishing the action result definitions in `tools/list`. This keeps the richer Snapshot observations within the existing catalog budget.
