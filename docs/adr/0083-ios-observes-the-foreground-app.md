---
status: accepted
---

# iOS observes the foreground app

> Amends [ADR 0066](./0066-ios-simulator-is-the-next-platform-runtime.md). Decided in [#710](https://github.com/akshat-OwO/contingency/issues/710).

ADR 0066 bound iOS observation to the Target App, because agent-device observed only the app it was bound to. When another app came forward, such as Springboard after Home or Settings, observation refused with `foreign_app_foreground`. Teaching capture paused until the user pressed **Return to Target App**. [ADR 0067](./0067-runtimes-trade-privacy-and-app-boundaries-for-reach.md) lets native agents use the whole OS, and [ADR 0082](./0082-native-sessions-carry-an-emulation.md) puts Home and the App Switcher on the iOS rail. Pressing either would pause the session at once. The iOS observer therefore follows whichever app is in front.

## Rules

- **Observation follows the foreground app.** Each observation reads the app in front: the Target App, Springboard, Settings, or another app. The Target App still names the journey and is the app preparation installs and launches.
- **Springboard names the app in front.** agent-device observes only the app its session is bound to, and binding to an app brings it forward. Springboard is always observable, and its tree shows one full-screen card for the app in front, or none on the Home Screen and in the App Switcher. The observer binds only to the app that card names, and binds to Springboard when the bound app's tree no longer covers the screen. After Home or the App Switcher it binds to Springboard at once.
- **No foreground refusal.** `foreign_app_foreground`, the Teaching capture pause it caused, and **Return to Target App** are removed. Teaching keeps capturing in any app, and a Run never pauses because another app is in front.
- **An app that comes forward on its own is followed only when it is clear.** A link or button can bring another app forward without a Contingency key. The observer then reads the simulator's apps' scheduling priority on the host, and follows only when exactly one app stands clearly above the rest. The app agent-device just refused to observe is left out, because it runs high for about a second while it hands over; so are UIKit hosts the session never binds to, such as the widget renderer and agent-device's runner. An unclear reading is read again over about two seconds. Its own full-screen tree then confirms the guess. Otherwise observation refuses with `foreground_app_unknown` and sends nothing. Recovery, by the user or the agent, presses Home and carries on from Springboard, and Teaching keeps recording. A wrong guess would bring the wrong app forward under the user, and Home is a screen the observer can always read, so the observer pauses rather than guess.
- **The iOS rail has no Back.** iOS has no system Back, as ADR 0066 states. The rail holds Home, App Switcher, the rotate toggle, and Device settings. Home and App Switcher are sent through agent-device, because the simulator HID helper sends only pointer and keyboard input.
- **The Support Matrix proves it.** Each iOS Support Matrix cell includes a journey through another app and back.

## Consequences

ADR 0066's limit "Other apps, Settings included, are a documented iOS limit" no longer applies, and neither do its rules on `foreign_app_foreground` and Return to Target App.
