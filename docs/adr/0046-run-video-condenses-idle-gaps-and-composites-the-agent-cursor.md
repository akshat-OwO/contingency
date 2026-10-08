# Run video condenses Idle Gaps and composites the agent cursor

Interactive Runs and Dry Runs recorded video live through Playwright `recordVideo`, so the video played in real time. Most of it was a still Page while the agent thought, and the agent's cursor was missing: the Workspace draws that cursor over the live canvas, and the Page never contains it. Now a Run records footage from the same screencast the Workspace shows, and after the Run ends Contingency condenses it in the background. Each Action Window plays at real speed with the agent's cursor drawn in. Each Idle Gap is fast-forwarded behind an on-screen badge. The condensed file replaces the footage.

## Considered Options

- **Change the player's playback rate and keep the real-time file**: rejected. A downloaded or handed-off video would still be mostly idle, and every viewer would need the same playback logic.
- **Inject a cursor element into the Page during the Run**: rejected. It would appear in the agent's screenshots, Browser Snapshots, and the Trace's DOM snapshots, and it would change the Page under test.
- **Pace the Run so actions land on camera**: rejected for the reason ADR 0014 gave. It slows the thing being observed to serve the artifact.

## Consequences

- **The video is not wall-clock time.** The Run Summary stores a time map from Run time to video time, with one entry per Action Window and Idle Gap. Any later seek-to-evidence feature must go through the map.
- **Footage keeps the screencast's own clock.** Each frame is stamped with the moment Chromium painted it and written to VP9 through a Matroska stream with explicit timestamps, so the agent's pointer events and Action Windows line up with the frames exactly. Playwright's recorder exposes no such clock. The footage follows whichever tab is active, as the Workspace does.
- **Chromium draws, ffmpeg encodes.** Playwright's bundled ffmpeg has no overlay, text, or retiming filters. A hidden compositor page seeks the footage, draws the cursor and badge on a canvas, and hands each frame to ffmpeg as a JPEG. A frame identical to the one before it is not drawn again, so an Idle Gap over a still Page costs one draw.
- **The cursor comes from persisted pointer events.** The Run stores the same `BrowserAgentPointer` events the Workspace animates. The path and click-pulse math is shared, so the video cursor matches the cursor a live watcher saw.
- **Two fast-forward modes, set once per process** with `CONTINGENCY_MCP_VIDEO_FAST_FORWARD`. `capped` is the default: an Idle Gap plays at 2x and takes at most 3 seconds of playback, and the badge shows the real multiplier, such as "▶▶ 13x". `fixed` plays every Idle Gap at exactly 2x behind a "▶▶ 2x" badge. A per-Run choice is not offered, because the raw recording is gone after the re-encode.
- **Takeover always plays at real speed.** A person is acting during Takeover, so it is never part of an Idle Gap.
- **Video never blocks the outcome.** The Agent Assessment and the Run outcome are final before encoding finishes. The Workspace asks the video's status route and shows "Preparing video…" until the file is ready. If encoding fails, the footage becomes the Run's video, played in real time, and the reason is recorded. Footage a process left unencoded when it exited is picked up the next time its status is asked; a lock file naming the encoding process keeps two processes from encoding the same Run.
- **The raw recording is deleted after a successful encode.** One video per Run means one fewer sensitive file on disk. ADR 0010's stance still applies: the video is unredacted.
