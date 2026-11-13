---
status: accepted
---

# Workspace user input is forwarded directly

> Amends [ADR 0058](./0058-android-is-the-next-platform-runtime.md), [ADR 0060](./0060-use-stock-agent-device-for-an-experimental-android-runtime.md), and [ADR 0066](./0066-ios-simulator-is-the-next-platform-runtime.md).

Android and iOS Workspace input must feel as responsive as the browser's. The browser forwards each pointer and key event straight to the Page. Native runtimes resolved every user click semantically: a fresh observation, a hit-test, validation, dispatch, and a post-action observation, serialized behind background observations. That took several seconds per click, and no amount of trimming reaches browser latency while each click waits on an observation. User input in the Workspace on a native runtime is therefore Forwarded Input. It reaches the device at once, as it does in the browser, during setup, Teaching, and Takeover. Agent actions stay semantic.

## Rules

- **The latency bar is the browser's.** On the same host and for the same gesture class, time from a canvas input to the first visible response in the stream is within 1.5× of the browser's at p50 and p95. Command completion is reported but is not the bar.
- **Every gesture is forwarded.** Taps, long presses, swipes, scrolls, drags, and hardware keyboard input reach the device as a pointer and key stream. Every input inside the streamed frame is forwarded, the status bar and system navigation included; "nothing to activate" is not a refusal for user input.
- **Validation leaves the input path.** Device identity and session checks run at Start, on device and app events, and on a slow background cadence. A failed check pauses the session and marks the Forwarded Input since the last passing check as unverified.
- **Teaching attributes after dispatch.** Teaching records each Forwarded Input against the latest observation taken before it and an observation taken after it. When the earlier observation predates the last screen change, the target is marked inferred. Keystrokes and scroll gestures coalesce into single actions as the browser's capture does, so native and browser Teaching Timelines read alike.
- **Observation never blocks input.** Observations run on their own lane, triggered when input settles and on a slow idle cadence. Input arriving mid-observation marks that observation stale instead of waiting for it. An observation that needs no image takes no screenshot.
- **Transports.** Android injects through the scrcpy control channel its stream already opens. iOS injects through a Contingency-owned simulator HID helper pinned to the Xcode versions of its Support Matrix. Until a spike proves the iOS helper, iOS keeps semantic user input and says so.

## Considered Options

- **Keep semantic picks and remove redundant work.** Rejected: it shortens the wait but every click still pays for an observation, so it cannot meet the browser's latency.
- **Dispatch at once only when a cached observation is fresh and its hit-test passes.** Rejected: the cache is stale after every screen change, which is exactly when the user clicks next.
- **Store coordinates and screenshots only, and let the learning agent resolve targets.** Rejected: the browser's Teaching Recording carries accessibility evidence with each action, and native recordings should too.
- **XCTest coordinate gestures on iOS.** Rejected: each gesture is synthesized whole from fixed endpoints, so a drag cannot follow the pointer, and each takes hundreds of milliseconds.
- **An idb companion on iOS.** Rejected: another dependency that uses the same private HID path underneath.

## Consequences

- ADR 0058's "semantic targets where available" and ADR 0060's deferral of coordinate input no longer apply to user input in the Workspace. Agent actions keep both.
- ADR 0066's "raw coordinates are refused" and "all input passes through session authority" now mean that input is sent only from the Workspace canvas by the user in control, not that each input is resolved to a semantic target first.
- The iOS HID helper uses private simulator APIs. An Xcode release outside the Support Matrix can break it, so the matrix gates it as it gates the runtime.
- A Teaching step may carry an inferred target. The learning agent treats it as weaker evidence than one resolved from a fresh observation.
