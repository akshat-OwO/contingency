# Calibration: video capture overhead on Core Web Vitals

An experiment for [issue #25](https://github.com/akshat-OwO/contingency/issues/25), which decides an open question from [ADR 0010](../../docs/adr/0010-run-video-is-unredacted.md): must video capture be stopped and restarted around each measured navigation — a segmented recording with gaps — or can it run continuously for a whole Run?

Core Web Vitals are collected unthrottled ([ADR 0008](../../docs/adr/0008-performance-is-a-navigation-step-toggle.md)), so the cost of recording lands directly in the reported numbers. This experiment measures how much, by running the same Flow against the same unchanging local page with capture on and with capture off, and comparing LCP and INP.

## Running it

From `packages/cli`:

```
nub tests/calibration/video-overhead.ts [pairs]
```

`pairs` defaults to 10 — ten Runs per condition — and takes a few minutes. `ffmpeg` must be on the `PATH`, because the browser tool encodes recordings with it; without it the video condition would claim to measure the cost of recording while recording nothing, so the experiment refuses to run.

The summary prints to stdout and every Run's numbers are written to `results.json` beside this file (gitignored: the numbers describe the machine that produced them, so they are reported on the ticket instead of committed).

## What it does

- Serves `fixtures/calibration.html` over real HTTP. The page is fixed: a hero image the server answers after 120ms, so LCP lands mid-load the way a real hero image does, and a button whose click handler blocks the main thread for 120ms, so INP sits well above its 16ms reporting floor.
- Discards one Run of each condition first: those Runs pay one-time costs — browser install, daemon start, cold page cache — that no counted Run pays.
- Interleaves the two conditions in pairs, alternating which condition of each pair goes first, so a machine that warms, cools, or busies itself during the experiment does so to both conditions equally.
- Runs every Run through the real Runner against the real bundled browser (the integration suite's `IntegrationLive` layer), because what matters is what `--video` costs a real Run, not what it costs a mock.
- Counts a Run only when it completed, the hero image was actually fetched (a warm-cache Run measured a different page load), and — for the video condition — a recording really was written.

## What it reports

Medians and spread (IQR, min, max) for LCP and INP in both conditions, the difference between the medians, and every individual Run's numbers, so a bimodal shape cannot hide inside a median.

## Not a test

This never gates CI. An experiment informs a decision; it does not assert one. The file is not named `*.test.ts`, so neither vitest configuration picks it up, and it has no `test` script wired to it. If the result changes a decision recorded in ADR 0008 or ADR 0010, that ADR is updated and the numbers are reported on the ticket.
