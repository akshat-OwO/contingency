# Run artifacts are properties of the Run, and video is derived from the trace

> Amends [ADR 0010](./0010-run-video-is-unredacted.md).

A Run captures a Playwright trace by default (`--trace`, on unless disabled) and can additionally emit a video (`--video`). Both are CLI flags; the `video` field is removed from the Flow, because whether to keep an artifact is a fact about how a Run was invoked — CI wants traces and no video, local work wants both — and not a fact about the Flow. The video is **generated from the trace's per-action screenshots** rather than captured live.

## Considered Options

- **Pace the Run so Steps land on camera** ([issue #45](https://github.com/akshat-OwO/contingency/issues/45)) — rejected. It slows the thing being measured to serve the artifact, and Core Web Vitals ([ADR 0008](./0008-performance-is-a-navigation-step-toggle.md)) and Regression comparison both read from that Run.
- **Post-process the captured WebM**, holding frames at Step boundaries using `run.json` timestamps — kept as the fallback if motion ever matters. It preserves a truthful Run and expands only the artifact.
- **Capture at high fps and slow it in the player** — does not fix a Run whose recording is truncated.

## Consequences

- **The evidence.** A real Run against a live site: navigate 1188ms, then click 27ms, change 14ms, click 14ms — 55ms of Steps. Its recording was 1.8s at 10fps against a 4.45s Run, so 60% of the Run was absent from the file, and all three post-navigation Steps fit inside a single inter-frame gap. Playwright's auto-waiting does not fix this: it waits for actionability and then fires immediately, which on a loaded page is under 10ms. Perceptibility is a function of wall-clock duration per Step, so no frame rate rescues a 14ms Step. Deriving the video from per-action screenshots makes Step visibility a property of construction rather than of sampling luck.
- **Live video capture is retired**, and with it most of ADR 0010's operational surface: the encoder, the fresh-context rebuild that dropped `localStorage`, the blank-page-only constraint, the attach settle, the idle-encoder wedge, and the capture-versus-Core-Web-Vitals overhead calibrated for issue #25. Those consequences described a capture pipeline Contingency no longer runs.
- **The derived video is a slideshow, not motion.** A CSS animation or hover transition will not appear. This is accepted; the trace is the inspection artifact, and the video exists to be watched by a human or attached to a Handoff.
- **Traces are sensitive and are not redacted.** A trace holds full DOM snapshots and network payloads, so it captures secret Variable values typed into fields — a strictly larger exposure than ADR 0010's video, which at least renders a password field as dots. ADR 0010's stance carries over unchanged: artifacts are unredacted and must be treated as credentials. Best-effort scrubbing is attempted, but DOM snapshots make completeness unprovable, and claiming a scrubbed trace would be worse than saying plainly that it is not. `containsSecrets` continues to gate any future upload adapter. Scrubbing of _error messages and selector diagnostics_ is separate and is a hard requirement ([ADR 0012](./0012-playwright-is-the-in-process-browser-runtime.md)), because there it is provable.
- **Issue #45 closes.** Its story 6 (pacing must work for imported Chrome Recorder JSON) was already dead under [ADR 0011](./0011-flow-is-a-native-format.md), and its story 5 (flag paced captures so Baselines do not compare paced against unpaced) dissolves along with pacing itself.
