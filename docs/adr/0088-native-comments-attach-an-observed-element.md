---
status: accepted
---

# Native comments attach an observed element

> Decided in [#770](https://github.com/akshat-OwO/contingency/issues/770), part of [#764](https://github.com/akshat-OwO/contingency/issues/764).

On the web, a Teaching comment can name the element it is about. Native comments could hold only text. Now the native comment composer has **Attach element** too. The user picks an element on the device screen, and the Instruction records it.

## How an element is picked

The Workspace already holds the session's latest observation, with each node's role, name, target, and bounds, which Screen elements lists. Picking reads only that observation and sends nothing to the device. While a comment picks, the glass is a picker: the outline follows the pointer to the smallest field or control under it, else the smallest named element, and a click attaches it. A control's label is often a smaller text node with the same name, so a field or control wins over text; the first live iOS proof attached `text "Sign in privately"` before this rule. Screen elements opens beside the glass in attach mode, so a keyboard can attach any element a pointer can. Escape cancels the pick. This is the one time something covers the glass, an exception to [ADR 0076](./0076-workspace-user-input-is-forwarded-directly.md), and it lasts only for the pick.

## What the command and the recording carry

- **The command names a node of an observation.** The `instruction` command takes an optional `element: { observationId, target }`. iOS shares the command.
- **The server refuses an element that left the screen.** The named observation must still be retained, and its node uncovered. The latest observation must show a node with the same role, name, and bounds, with no Forwarded Input since that observation began. A later observation of the same screen keeps the pick valid even though iOS renames every target. Otherwise the comment is refused and nothing is recorded.
- **The event keeps `target` and adds `element`.** `target` stays a role-and-name phrase, such as `button "Edit"`, so every reader of a web comment reads a native one the same way. A new optional `element` field holds what native learning needs: the platform, the observation id, role, name, editable, the app in `context` as action targets name it, and the bounds when known. Recordings without `element`, and every web comment, still decode.

## Considered Options

- **Widen `target` to a union of a string and a native struct**: rejected. Every consumer of `target` would need to narrow it, including the web comment history and the session event comparison, for data only native learning reads.
- **Resolve the pick on the server from a point**: rejected. The outline must follow the pointer without a round trip, and the client already holds the same nodes and bounds.
- **Record the target ref alone**: rejected. Refs are per observation, and on iOS per generation. A later Run finds the element by role, name, and app, as it does for actions.

## Consequences

- The Teaching Timeline passes `element` through unchanged, so a learning agent reads it beside the comment's text.
- An attached element is only as current as the latest observation. A pick made just before the screen changes is refused, and the user picks again.
