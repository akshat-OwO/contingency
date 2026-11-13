---
status: accepted
---

# Native recordings use agent-device screen recording

Android and iOS Teaching, Dry Runs, and later Runs retain video for [issue 697](https://github.com/akshat-OwO/contingency/issues/697). The video comes from the pinned agent-device's own screen recorder (`adb screenrecord` on Android, `simctl io recordVideo` on iOS), not from the live display stream. The recorder already owns chunking past Android's 180-second limit, a durable on-device manifest, restart recovery, and a recorder-health result. Reusing it avoids writing an H.264 muxer and a second gap tracker against the stream.

## Considered Options

- **Tee the live display stream on the server** (Android H.264 packets into footage, iOS JPEGs into the timed encoder): rejected. It adds no device-side work and inherits iOS stream integrity, but needs new muxing and Android gap tracking. If the latency budget below fails, this option is reopened rather than worked around.
- **Bundle a full ffmpeg with H.264 decoding**: rejected. It adds a dependency with licensing and size cost; the bundled Chromium already decodes H.264 for rendering.

## Consequences

- **Every native video is rendered to VP9 WebM** through the ADR 0046 timed encoder, with a Chromium compositor that decodes the footage. The simulator's HEVC is first converted to H.264 with macOS `avconvert`, because the bundled Chromium cannot decode HEVC. Runs and Dry Runs are condensed with a time map; Teaching is re-encoded at real speed. Video never blocks Teaching or a Run outcome; Teaching shows a preparing state after Stop. Raw chunks are deleted after a successful render; on failure the raw footage plays instead and the reason is recorded.
- **The recorder's clock is the server's time when its start resolves.** The time map and every evidence offset count from that moment; frame times come from each footage file's own sample table, since Android encodes a frame only when the screen changes.
- **Start waits for the recorder.** Teaching Start and Run start complete once the recorder confirms it is running. If it cannot start, Start still succeeds and the evidence records that no video was captured and why.
- **Gaps are explicit.** agent-device starts Android's next recorder every 170 seconds and stops the previous one only after the next shows frames, so chunk handovers overlap and lose nothing. Each chunk is placed one rotation and one measured launch after the one before it, because a chunk's own length ends at its last screen change. A `lost` or `unconfirmed` recorder, a recorder that stopped before Stop, a session recovery, or the size limit makes it incomplete with exact intervals. Footage of another shape, such as after a rotation, is letterboxed.
- **Secure screens become Hidden Intervals.** `screenrecord` draws secure surfaces black, so the window focus is read once a second from Start to Stop regardless of viewers, and a secure or unreadable focus counts as hidden; and the renderer replaces those spans with a hidden card.
- **Touches stay hidden and the whole screen is recorded.** Showing touches would change the device under test, as ADR 0046 found for an injected cursor. A touch overlay from persisted input events is follow-up work.
- **Cleanup removes the video with its session.** Footage, the capture record, and the rendered video live in the session's evidence directory, so verify-then-purge deletes them with it. agent-device retires its on-device copy when the recorder stops; a copy it reports as still on the device is noted in the evidence.
- **Latency budget.** Recording may raise forwarded-input-to-frame p95 latency by at most 10 ms on the same device. Exceeding it, after tuning recorder quality and bit rate, reopens the stream-tee option.
- Storage follows web Teaching: at most 25 fps, the existing 1280 px maximum, a 500 MB soft budget and a 4 GB hard cap that ends video capture as incomplete without ending the session.
