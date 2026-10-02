import { AgentElementRef } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { InspectOverlay } from "@/components/agent/teaching-inspect";
import {
  emptyInspectState,
  flatFrameProjection,
} from "@/components/agent/teaching-inspect-state";

afterEach(cleanup);

test("shows selection failure without an editor and clears it on a successful retry", () => {
  const props = {
    canvas: null,
    onAttach: vi.fn(),
    onCancel: vi.fn(),
    onDraftChange: vi.fn(),
    onExit: vi.fn(),
    onFreeze: vi.fn(),
    onHover: vi.fn(),
    projection: flatFrameProjection,
  };
  const { rerender } = render(
    <InspectOverlay
      {...props}
      state={{ ...emptyInspectState, error: "No target", open: true }}
    />
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Try another visible element"
  );
  expect(
    screen.queryByRole("textbox", { name: "Describe the change" })
  ).toBeNull();
  rerender(
    <InspectOverlay
      {...props}
      state={{
        ...emptyInspectState,
        frozen: {
          description: "button: Change quantity",
          height: 40,
          ref: AgentElementRef.make("e1"),
          scrollOffsetX: 0,
          scrollOffsetY: 0,
          width: 100,
          x: 20,
          y: 30,
        },
        open: true,
      }}
    />
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("textbox", { name: "Describe the change" })
  ).toBeVisible();
});
