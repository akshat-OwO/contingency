# Run video is captured unredacted

A Run may be captured to video (`Flow.contingency.video`, or `--video`), using the browser's session-scoped WebM recording. Capture is **not** suspended while a Step enters a secret value. Video therefore contains secrets in plaintext — a 2FA code, an API key, or any credential typed into a field that is not `type="password"` is rendered on screen and written to the file — while `run.json` redacts those same values.

This is accepted rather than solved, because the alternatives were worse for now: masking a target's bounding box relies on a selector that may be stale, and a mis-computed box leaks the credential anyway. Segmenting capture around secret-bearing Steps remains available later; it is cheap, since a fill Step is sub-second.

## Consequences

- `--video` warns when the Flow declares any Variable with `secret: true`, and the segment manifest records `containsSecrets: true` so a future upload adapter refuses by default rather than shipping credentials to object storage.
- Recording adds overhead to the machine under measurement, inflating LCP and INP and widening run-to-run variance. Measurement is unthrottled ([ADR 0008](./0008-performance-is-a-navigation-step-toggle.md)), so that overhead lands directly in the reported numbers rather than being absorbed by a device model. The magnitude is unmeasured; a calibration experiment decides whether capture must be segmented around measured navigations. That experiment informs a decision and never gates CI.
- Whether video was captured is recorded in the Run, so Baseline comparison can flag a recorded-versus-unrecorded comparison.
- The recording lifecycle is owned by a scoped finalizer: an unflushed file is a lost file, and the Runs whose video matters most are the ones that abort. Each retry attempt stops the previous recording and produces its own labeled file.
- Video is retained indefinitely until an upload adapter exists. Disk growth is currently the operator's problem.
