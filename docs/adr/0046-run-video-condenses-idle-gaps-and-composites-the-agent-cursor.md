# Run video condenses Idle Gaps and composites the agent cursor

Interactive Runs and Dry Runs record video live through Playwright `recordVideo`, so the video plays in real time. Most of it is a still Page while the agent thinks, and the agent's cursor is missing: the Workspace draws that cursor over the live canvas, and the Page never contains it. After a Run ends, Contingency re-encodes the recording in the background. Each Action Window plays at real speed with the agent's cursor drawn in. Each Idle Gap is fast-forwarded behind an on-screen badge. The re-encoded file replaces the raw recording.

## Considered Options

- **Change the player's playback rate and keep the real-time file**: rejected. A downloaded or handed-off video would still be mostly idle, and every viewer would need the same playback logic.
- **Inject a cursor element into the Page during the Run**: rejected. It would appear in the agent's screenshots, Browser Snapshots, and the Trace's DOM snapshots, and it would change the Page under test.
- **Pace the Run so actions land on camera**: rejected for the reason ADR 0014 gave. It slows the thing being observed to serve the artifact.

## Consequences

- **The video is not wall-clock time.** The Run Summary stores a time map from Run time to video time, with one entry per Action Window and Idle Gap. Any later seek-to-evidence feature must go through the map.
- **The cursor comes from persisted pointer events.** The Run stores the same `BrowserAgentPointer` events the Workspace animates. The path and click-pulse math is shared, so the video cursor matches the cursor a live watcher saw.
- **Two fast-forward modes, set as a catalog-wide CLI/config option.** `capped` is the default: an Idle Gap plays at 2x and takes at most 3 seconds of playback, and the badge shows the real multiplier, such as "▶▶ 13x". `fixed` plays every Idle Gap at exactly 2x behind a "▶▶ 2x" badge. A per-Run choice is not offered, because the raw recording is gone after the re-encode.
- **Takeover always plays at real speed.** A person is acting during Takeover, so it is never part of an Idle Gap.
- **Video never blocks the outcome.** The Agent Assessment and the Run outcome are final before encoding finishes. The Workspace shows "Preparing video" until the file is ready. If encoding fails, the raw recording stays as the Run's video and the reason is recorded.
- **The raw recording is deleted after a successful encode.** One video per Run means one fewer sensitive file on disk. ADR 0010's stance still applies: the video is unredacted.
- **Multi-page Runs are out of scope.** The Run's video still covers only its first Page.
