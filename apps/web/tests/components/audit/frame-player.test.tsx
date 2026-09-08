import type { RunVideoSegment, VideoFrameTarget } from "@contingency/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import type { TimelineStep } from "@/components/audit/audit-workspace-state";
import { FramePlayer } from "@/components/audit/frame-player";

afterEach(cleanup);

/** Steps 1 and 3 of the Flow ran; Step 2 was never reached, so has no frame. */
const segment: RunVideoSegment = {
  attempt: 1,
  file: "attempt-1.webm",
  includesSettledState: true,
  recorded: true,
  steps: [0, 1, 3],
};

const timeline = [0, 1, 2, 3].map((index): TimelineStep => ({
  findings: [],
  index,
  label: `Step ${index}`,
  result: undefined,
  state: "done",
  type: "click",
}));

const player = (
  selected: VideoFrameTarget | undefined,
  source: RunVideoSegment = segment
) => {
  const onPin = vi.fn();
  render(
    <FramePlayer
      onPin={onPin}
      segment={source}
      selected={selected}
      src="/runs/run-1/video/1"
      timeline={timeline}
    />
  );
  return onPin;
};

test("moves in whole Steps, skipping one the attempt never reached", async () => {
  const onPin = player({ index: 1, kind: "step" });
  await userEvent.click(screen.getByRole("button", { name: "Next Step" }));
  // Step 2 has no frame, so the next Step is the next one that has one.
  expect(onPin).toHaveBeenCalledWith({ index: 3, kind: "step" });
  await userEvent.click(screen.getByRole("button", { name: "Previous Step" }));
  expect(onPin).toHaveBeenCalledWith({ index: 0, kind: "step" });
});

test("stops at the ends rather than wrapping", () => {
  player({ index: 0, kind: "step" });
  expect(screen.getByRole("button", { name: "Previous Step" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next Step" })).toBeEnabled();
});

test("puts a marker on the transport for every frame, and pins on a click", async () => {
  const onPin = player({ index: 0, kind: "step" });
  const markers = screen.getAllByRole("button", { name: /^Step \d/u });
  expect(markers).toHaveLength(segment.steps.length);
  await userEvent.click(markers[2]);
  expect(onPin).toHaveBeenCalledWith({ index: 3, kind: "step" });
});

test("places Step markers at frame boundaries, starting at 0:00.0", () => {
  player({ index: 0, kind: "step" });
  expect(screen.getByRole("button", { name: /^Step 0/u })).toHaveStyle({
    left: "0%",
  });
  expect(screen.getByRole("button", { name: /^Step 1/u })).toHaveStyle({
    left: "25%",
  });
  expect(screen.getByRole("button", { name: /^Step 3/u })).toHaveStyle({
    left: "50%",
  });
  expect(screen.getByRole("button", { name: "Run settled" })).toHaveStyle({
    left: "75%",
  });
});

test("offers a Run settled marker after the last Step, never labelled as a Step", async () => {
  const onPin = player({ index: 3, kind: "step" });
  const terminal = screen.getByRole("button", { name: "Run settled" });
  expect(terminal).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "Next: Run settled" })
  );
  expect(onPin).toHaveBeenCalledWith({ kind: "settled" });
  await userEvent.click(terminal);
  expect(onPin).toHaveBeenCalledWith({ kind: "settled" });
});

test("hides the Run settled marker when capture produced no settled frame", () => {
  player(
    { index: 0, kind: "step" },
    {
      attempt: 1,
      error: "The Trace did not capture the final settled state.",
      file: "attempt-1.webm",
      includesSettledState: false,
      recorded: true,
      steps: [0, 1, 3],
    }
  );
  expect(screen.queryByRole("button", { name: "Run settled" })).toBeNull();
  expect(
    screen.getByText("The Trace did not capture the final settled state.")
  ).toBeVisible();
  expect(screen.getByRole("button", { name: /^Step 3/u })).toBeVisible();
});

test("moves from the last Step to Run settled with the arrow keys", async () => {
  const onPin = player({ index: 3, kind: "step" });
  screen.getByRole("region", { name: "Derived frames" }).focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(onPin).toHaveBeenCalledWith({ kind: "settled" });
  cleanup();
  const onPinBack = player({ kind: "settled" });
  screen.getByRole("region", { name: "Derived frames" }).focus();
  await userEvent.keyboard("{ArrowLeft}");
  expect(onPinBack).toHaveBeenCalledWith({ index: 3, kind: "step" });
});

test("says the video could not be loaded rather than showing an empty player", () => {
  player({ index: 0, kind: "step" });
  const video = document.querySelector("video");
  expect(video).not.toBeNull();
  fireEvent.error(video);
  expect(screen.getByText(/could not be loaded/u)).toBeVisible();
});

test("does not snap back to the pinned Step while the segment is playing", () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause");
  // jsdom loads nothing: nothing is seekable until the file can play.
  const seekable = vi.spyOn(HTMLMediaElement.prototype, "seekable", "get");
  seekable.mockReturnValue({ length: 0 } satisfies TimeRanges);
  player({ index: 1, kind: "step" });
  const video = document.querySelector("video");
  expect(pause).toHaveBeenCalledTimes(1);

  // A seek against an unseekable resource is dropped, so `canplay` retries it
  // once the file can play.
  seekable.mockReturnValue({ length: 1 } satisfies TimeRanges);
  fireEvent.canPlay(video);
  expect(pause).toHaveBeenCalledTimes(2);

  // The seek has landed; a readiness event during playback must not re-issue
  // it: that would pause and rewind mid-play.
  fireEvent.canPlay(video);
  fireEvent.canPlay(video);
  expect(pause).toHaveBeenCalledTimes(2);
  vi.restoreAllMocks();
});

test("keeps stepping available from a Step the attempt never reached", async () => {
  // Step 2 has no frame of its own; the arrows step from where the playhead
  // is rather than going dead until something with a frame is clicked.
  const onPin = player({ index: 2, kind: "step" });
  expect(screen.getByRole("button", { name: "Next Step" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Next Step" }));
  expect(onPin).toHaveBeenCalledWith({ index: 1, kind: "step" });
});
