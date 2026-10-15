# Android display transport

Workspace uses the scrcpy transport packaged in `expo-device-hub` 0.15.3, source `42918bc8e66021da5a983aaa09b43365e58c3dce`. Packaging copies only `scrcpy.js`, `scrcpy-server.js`, `exec.js`, and the upstream MIT and Apache-2.0 licenses. It loads no hub dashboard, HTTP server, input router, or recorder. The native WebRTC dependencies are not used or shipped.

`scrcpy-server-v4.0` comes from the Genymobile scrcpy v4.0 release: https://github.com/Genymobile/scrcpy/releases/download/v4.0/scrcpy-server-v4.0

Its SHA-256 is `84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a`. The worker checks that hash before starting. It supplies the bundled file to the stock transport, so its download fallback is never called. The server's Apache-2.0 license is in `SCRCPY-LICENSE`.

The session owns one child process and its selected serial. Frames travel over the child's stdout into a bounded, authenticated HTTP display stream. No hub port is opened. Each viewer begins on a keyframe. A slow viewer disconnects instead of accumulating frames or silently dropping H.264 deltas. Workspace requires a browser with WebCodecs H.264 decoding.

The stock transport owns a serial-specific ADB forward and random working server path. It closes them on shutdown. Contingency also removes the exact generation's forward and working paths after worker exit, including SIGKILL. The stock content-addressed server cache is reusable and is retained. Other sessions' forwards and files are never removed.

Window visibility is checked through the selected device's window report. Secure windows produce a notice, and unknown visibility suppresses frames. scrcpy respects Android's secure-surface restrictions. The diagnostic notice can lag a transition by the one-second check interval; this stream does not provide pixel redaction or outcome evidence. Teaching keeps observation keyframes independently of the display transport.
