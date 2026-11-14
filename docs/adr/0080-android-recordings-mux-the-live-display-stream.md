---
status: accepted
---

# Android recordings mux the live display stream

> Partly supersedes [ADR 0079](./0079-native-recordings-use-agent-device-screen-recording.md) for Android. iOS keeps agent-device recording.

ADR 0079 recorded Android with agent-device's `screenrecord` and allowed recording to raise Forwarded Input latency by at most 10 ms. On the Pixel_9 emulator it raised the first visible response to a tap by about 70 ms at p50 and 180 ms at p75 ([#703](https://github.com/akshat-OwO/contingency/pull/703)). The ADR allowed tuning first, but there was nothing to tune: agent-device offers only `medium` (8 Mbps, already in use) and `high` (20 Mbps). So ADR 0079's stream-tee option reopened ([#704](https://github.com/akshat-OwO/contingency/issues/704)).

Android Teaching, Dry Runs, and Runs now record the session's own display stream. The server takes the H.264 packets the stream worker already sends to viewers and muxes them into fragmented MP4 with the pinned expo-device-hub `ScreenRecording`. Nothing is encoded twice, and the device does no extra work.

## Considered Options

- **Lower `screenrecord`'s bit rate**: rejected. agent-device offers no setting below the one in use, and an in-guest software encoder would still compete with the app under test.
- **Mux in the stream worker**: rejected. The worker is restarted when the stream is lost, and its stdout carries viewer frames. Muxing in the server keeps a recording across worker restarts and keeps a recorder failure away from the live view.

## Consequences

- **Recording holds the stream.** While the recorder runs, the worker runs, with or without a viewer, and a lost worker starts again after one second. A Run with no viewer records.
- **A recorder joins at the screen as it is.** The encoder sends a keyframe every 60 frames, and an idle screen sends two frames a second, so a recorder could wait 30 seconds for one. The stream keeps the frames since the last keyframe, at most 8 MiB, and gives them to a recorder that joins. Each file is placed on the video's timeline by its own timestamps, so a file can start before the recorder's zero.
- **One file per stream shape.** A display size change, a codec change, or a timestamp that does not increase (a restarted worker) ends the open file and starts the next at the following keyframe. The time between files is a `recorder-restarted` gap. The capture record keeps each file's start; older records still place files by agent-device's rotation.
- **A lost stream stays lost until footage is kept.** A `connecting` state from a new worker does not clear the loss; only a frame the recorder keeps does.
- **A recorder that falls behind misses frames, never states.** The stream holds at most 256 frames for the recorder. Past that it drops frames until the next keyframe and sends a `skipped` packet before it. The recorder ends the file at its last kept frame and starts the next at that keyframe, placed by the stream's timestamps, so the missed time is a `recorder-restarted` gap. States are always delivered, so Hidden Intervals and losses are never missed.
- **Secure screens.** The worker withholds frames while a secure or unclassified window has focus, so footage never holds them. A `secure` state from the worker opens a Hidden Interval, and the next state closes it. An unclassified window holds the last frame instead of a card.
- **The 4 GB cap counts the file being written,** as well as finished files.
- **Files stay under the hub's byte limit.** The hub fails a write past 4 GiB instead of finishing the file, so a file ends at its next keyframe after 1 GiB. If the hub fails a file anyway, the recorder keeps the fragments it flushed, each of which plays, and the rest of that file becomes a gap.
- **Packaging ships** `screen-recording.js`, `recording-file-target.js`, and mediabunny 1.55.3 (MPL-2.0, unmodified). The frame-table reader also reads fragmented MP4's `moof` boxes.
- **Latency.** On the same emulator, recording on and off are within run-to-run noise. The measurements are in [#704](https://github.com/akshat-OwO/contingency/issues/704)'s PR.
