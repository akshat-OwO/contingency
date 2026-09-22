# A screenshot arrives as a local file

`agent_browser_screenshot` answers with the path of the PNG it just wrote, its size, its capture time, and the Page URL. It does not carry the image bytes. The external agent opens that path with its own file tools.

[ADR 0032](./0032-external-agents-receive-a-bounded-teaching-feed.md) kept this one tool on inline base64 because a deliberate capture is not a projection over a whole Demonstration. That reasoning held only while a capture stayed small. A 390x844 Page at device scale factor 3 is roughly 1.1 million characters of base64, which is past what an agent can take as a tool result, so the tool became unusable exactly when the accessibility representation was not enough — its whole reason to exist.

Downscaling the capture was rejected: the agent asks for pixels when the Browser Snapshot has already failed it, and a resampled image can lose the rendering detail it was reaching for. A path costs a few dozen characters at any resolution, and the agent may downscale, crop, or discard the file itself.

The file is written into a per-session temporary directory created on the first capture and removed when the Agent Session's scope closes, so it lives exactly as long as the session that can still be asked about it. The directory sits under the MCP process's owned resource directory, which the existing startup scavenger already reclaims after a crash. Nothing durable is written, and Teaching keyframes are unaffected: they still travel as content-addressed references and are fetched one at a time with `agent_teaching_keyframe_get`.

Local paths are exposed here, unlike the Teaching timeline, which deliberately hides artifact paths. The difference is ownership: this file holds one capture the agent itself asked for in a live session it drives, not a projection over the user's recorded evidence.
