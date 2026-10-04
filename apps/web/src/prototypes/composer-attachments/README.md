# Prototype: attaching requests, storage, and scans to Teaching comments

Follow-up to issue #363. The **1 · Attach** direction from the `teaching-conditions` reference prototype gave the composer three attach buttons, inline check cards, a step picker, and a sentence preview at once, and it had no performance or accessibility scans. These four directions keep the accepted behavior from #363 but try to make it easier to use:

| Direction | Where requirements are made | Composer toolbar |
| --- | --- | --- |
| **A · Drag from DevTools** | Drag a Network row, response field, or cookie onto the comment (or use the row's paperclip) | Element · Performance · A11y |
| **B · Require in DevTools** | Press **Require** on a row or field; checks and scans live in a **Checks** rail panel | Element only |
| **C · One attach menu** | One **Attach** button, or `/` in the comment, opens one menu for everything | Attach |
| **D · Suggested** | The composer lists what the last step caused; press one to require it | Element |

All four share the same rules:

- Plain comments stay the default.
- Everything attached shows up as a chip. Pressing a chip opens one editor: **Context for the agent** or **Must happen**. For requests, that includes the nested response-field tree.
- A cookie the page hasn't set yet can be named. Naming it never creates it.
- Performance (reload, navigation, timespan with an end) and accessibility scans are first-class.
- The composer is non-modal. In A and B, DevTools stays usable while a draft is open.

## Run it

```sh
cd apps/web
nub run dev
# open http://localhost:5173/prototypes/composer-attachments.html
```

The dock, inspector rail, chips (`ui/attachment`), popovers, command menu, and segmented controls are the production components. C and D use the production `BrowserDevtools`. A and B use a prototype panel that copies its layout and adds drag handles and row actions. The page, requests, cookies, and scans are mocked, and nothing is saved.
