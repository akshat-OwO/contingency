---
status: accepted
---

# Native sessions carry an Emulation

> Amends [ADR 0058](./0058-android-is-the-next-platform-runtime.md), [ADR 0066](./0066-ios-simulator-is-the-next-platform-runtime.md), and [ADR 0076](./0076-workspace-user-input-is-forwarded-directly.md). Decided in [#710](https://github.com/akshat-OwO/contingency/issues/710).

The native Workspace offered one Android Back key and no way to rotate the device or change its appearance or location. Before [ADR 0067](./0067-runtimes-trade-privacy-and-app-boundaries-for-reach.md), Home and the App Switcher would have left the Target App, so leaving them out was deliberate. That boundary is gone, so a journey may now press them, rotate the device, or change its environment. Recording only the taught gestures would make such a Flow replay differently on a device that starts in another orientation or appearance. Native sessions therefore carry an Emulation, as browser sessions do, and the device's own controls are first-class actions.

## Rules

- **Device keys are actions.** Back (Android only), Home, and App Switcher are each Forwarded Input from the Workspace's device rail, and each is a semantic action in Teaching steps, Flows, and agent tools. Home and App Switcher do not depend on the screen they leave, so unlike Back they do not refuse a changed screen. The keyboard's Home key still moves the text cursor.
- **The rail sits beside the frame and holds what acts on the device.** One vertical rail beside the frame holds the device keys, a rotate toggle between portrait and landscape-left, Device settings with appearance and geolocation, Screen elements, and Stream diagnostics. Its cards open beside the rail, never over the screen. Geolocation uses the browser's control. Everything that acts on the device is enabled only while the user is in control, and while the agent drives each one says why. Stream diagnostics only reads the stream, so it stays available. Power, volume, and screenshots are not on it. Amended in [#764](https://github.com/akshat-OwO/contingency/issues/764), which moved Screen elements off the dock and added Stream diagnostics.
- **Teaching records the starting Emulation.** A native Teaching Recording records the device's orientation, appearance, and location when Teaching starts, as its starting Emulation. Text scale and locale are starting-only fields.
- **A change mid-session is a step.** Rotating the device or changing its appearance or location during a session is a recorded action, and the Flow replays it at that point. The recorded Emulation stays the starting one.
- **A Run applies the starting Emulation.** Before launch, a Run or Dry Run applies the recorded starting Emulation. A field it cannot apply goes through the existing preflight check for environment differences.
- **The device gets its environment back.** Before the first change on a device the user selected, the session saves the device's original environment. It restores that environment at every session end, including failure and cancellation. If the process dies first, the next process start restores any saved environment whose device is still booted, under [ADR 0077](./0077-a-process-owns-the-devices-it-starts.md)'s ownership rules. A device Contingency booted itself is not restored.

## Considered Options

- **Leave the environment to the device.** Rejected: a Flow taught in portrait would fail, or pass by chance, on a device left in landscape by an earlier session.
- **Record only a starting Emulation and refuse changes mid-session.** Rejected: rotating the device or switching to dark appearance is often the behavior a journey checks.
- **Restore nothing.** Rejected: the user's own emulator would stay rotated or dark after a session they did not expect to change it.

## Consequences

- ADR 0058's semantic actions now include Home and App Switcher on Android.
- ADR 0066's taught iOS environment gains the starting Emulation.
- ADR 0076's Forwarded Input now covers the rail's keys and environment changes. Teaching attributes them as their own steps, not as key presses.
