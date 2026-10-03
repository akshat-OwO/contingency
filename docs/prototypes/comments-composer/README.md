# Prototype: Teaching comments without inspect

**Outcome:** D · Spotlight won and ships in the Workspace as the comment composer (`apps/web/src/components/agent/teaching-comment-composer.tsx`).

Throwaway prototype for overhauling how a user leaves comments (Instructions) during Teaching. Today a comment needs an inspected element: the dock's cursor toggle opens inspect, a click freezes an element, and a form opens beside it. A read-only count in the dock lists earlier comments.

The protocol already accepts an Instruction with a `null` target, so a page-level comment is a UI change only.

## Run it

```bash
cd docs/prototypes/comments-composer
python3 -m http.server 4320
# open http://127.0.0.1:4320/index.html
```

The grey strip at the top is prototype scaffolding. It switches variants (keys `1` to `4`), toggles dark mode, and resets the seeded comments. For variant A it also sets the dock placement.

## Shared behaviour

All four variants use the same model and the same inspect mode.

- Typing and pressing `Enter` adds a page comment. `Shift+Enter` adds a new line.
- `I` (or `⌘I` inside the field) starts inspect. A pill at the top says what to do and `Esc` cancels. Hovering outlines the element and labels it by role and accessible name, which is what `TeachingInstruction.target` stores.
- Clicking an element attaches it to the composer as a removable chip and focuses the field. `Backspace` in an empty field removes the chip.
- A comment with a target gets a numbered pin on the page. Clicking a pin opens the history at that comment. Hovering a history item outlines its element.
- History lists comments newest first, with the recording time and either the element or the page.

## Variants

|  | Idea | Collision with the dock | Strengths | Costs |
| --- | --- | --- | --- | --- |
| **A · Composer** | A floating composer bottom-left: inspect, field, history, send. History opens above it. | A placement option: `center` (≥1440px), `right` (≥1000px), `stacked` (narrow), or `auto`. | Always ready to type. Matches the original sketch. | Two floating surfaces. At laptop widths the dock has to move right. |
| **B · Unified dock** | The field is the dock's first row and the controls are its second row. History expands inside the same card. | None. There is one surface. | No collision to solve. Commenting is the dock's main job while recording. | The dock is taller and covers more of the page. |
| **C · Thread rail** | A collapsible right rail holds the thread, grouped by URL, with its composer at the bottom. On mobile it becomes a bottom sheet. | None. The page shrinks instead of being covered. | Best for reading many comments. Nothing covers the page. | It takes 340px of browser width while open, which changes the page's own layout. |
| **D · Spotlight** | Nothing extra on screen. `/` opens a command-palette composer with attach and history in one place. | None. The dock stays one row. | Cleanest canvas. Fast from the keyboard. | It is hidden until opened, so less discoverable. The palette covers the page while it is open. |

## Capture the evidence

```bash
npm i playwright-core --prefix /tmp/protoshot
NODE_PATH=/tmp/protoshot/node_modules node capture.mjs
```

`capture.mjs` walks 4 variants × 4 scenes (idle, history, inspect hover, attached and typing) at 1440px, 1180px, and 390px, plus dark mode at desktop width. It writes screenshots to the ignored `shots/` directory and fails on page errors or clipped controls.
