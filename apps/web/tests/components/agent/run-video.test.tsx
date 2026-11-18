import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { RunVideoPlayer } from "@/components/agent/run-video";

afterEach(cleanup);

const Player = ({ src }: { readonly src: string }) => (
  <RunVideoPlayer
    className={undefined}
    condensed={false}
    path={undefined}
    src={src}
    timeMap={undefined}
    timeline={[]}
    videoClassName={undefined}
  />
);

const previewSource = (container: HTMLElement) =>
  container.querySelector('video[aria-hidden="true"]')?.getAttribute("src");

test("previews seek frames from the recording the player now plays", () => {
  const { container, rerender } = render(<Player src="/first.webm" />);
  const seek = screen.getByRole("slider", { name: "Seek" });
  // Nothing loads for the preview until the pointer first hovers the scrubber.
  expect(previewSource(container)).toBeUndefined();
  fireEvent.pointerMove(seek, { clientX: 10 });
  expect(previewSource(container)).toBe("/first.webm");

  fireEvent.pointerLeave(seek);
  rerender(<Player src="/second.webm" />);
  // The last recording's preview never stays loaded for the new one.
  expect(previewSource(container)).toBeUndefined();
  fireEvent.pointerMove(seek, { clientX: 20 });
  expect(previewSource(container)).toBe("/second.webm");
});
