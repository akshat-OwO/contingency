import type { RunVideoSegment } from "@contingency/protocol";
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

const player = (selected: number | undefined) => {
  const onPinStep = vi.fn();
  render(
    <FramePlayer
      onPinStep={onPinStep}
      segment={segment}
      selected={selected}
      src="/runs/run-1/video/1"
      timeline={timeline}
    />
  );
  return onPinStep;
};

test("moves in whole Steps, skipping one the attempt never reached", async () => {
  const onPinStep = player(1);
  await userEvent.click(screen.getByRole("button", { name: "Next Step" }));
  // Step 2 has no frame, so the next Step is the next one that has one.
  expect(onPinStep).toHaveBeenCalledWith(3);
  await userEvent.click(screen.getByRole("button", { name: "Previous Step" }));
  expect(onPinStep).toHaveBeenCalledWith(0);
});

test("stops at the ends rather than wrapping", () => {
  player(0);
  expect(screen.getByRole("button", { name: "Previous Step" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Next Step" })).toBeEnabled();
});

test("puts a marker on the transport for every frame, and pins on a click", async () => {
  const onPinStep = player(0);
  const markers = screen.getAllByRole("button", { name: /^Step \d/u });
  expect(markers).toHaveLength(segment.steps.length);
  await userEvent.click(markers[2] as HTMLElement);
  expect(onPinStep).toHaveBeenCalledWith(3);
});

test("says the video could not be loaded rather than showing an empty player", () => {
  player(0);
  const video = document.querySelector("video");
  expect(video).not.toBeNull();
  fireEvent.error(video as HTMLVideoElement);
  expect(screen.getByText(/could not be loaded/u)).toBeVisible();
});

test("does not snap back to the pinned Step while the segment is playing", () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause");
  // jsdom loads nothing: nothing is seekable until the file can play.
  const seekable = vi.spyOn(HTMLMediaElement.prototype, "seekable", "get");
  seekable.mockReturnValue({ length: 0 } as TimeRanges);
  player(1);
  const video = document.querySelector("video") as HTMLVideoElement;
  expect(pause).toHaveBeenCalledTimes(1);

  // A seek against an unseekable resource is dropped, so `canplay` retries it
  // once the file can play.
  seekable.mockReturnValue({ length: 1 } as TimeRanges);
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
  const onPinStep = player(2);
  expect(screen.getByRole("button", { name: "Next Step" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Next Step" }));
  expect(onPinStep).toHaveBeenCalledWith(1);
});
