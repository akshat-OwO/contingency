# iOS Forwarded Input helper

`hid.m` is the Contingency-owned transport for Forwarded Input on the iOS Simulator ([ADR 0076](../../../../docs/adr/0076-workspace-user-input-is-forwarded-directly.md)). It opens SimulatorKit's private Indigo HID client for one booted simulator and injects the user's touches and keys, the path Simulator.app uses. It reaches no other simulator API.

It reads one command per stdin line and writes `ready <width> <height>` once the client is open:

- `touch <down|move|up> <x> <y>`: a finger at a fraction of the screen. Indigo drops a drag sent within 16 ms of the previous message, so `ios-hid.ts` spaces drags and keeps only the latest waiting one. A wheel arrives as a held finger.
- `key <down|up> <usage>`: a USB HID keyboard-page usage.

The packaging build compiles, ad hoc signs, and pins it with a manifest under `packages/cli/dist/ios/hid`, exactly as it does the framebuffer helper. Private SimulatorKit symbols change between Xcode releases, so the iOS Support Matrix gates the Xcode versions it is proven on.
