import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { InspectOverlay } from "@/components/agent/teaching-inspect";
import {
  emptyInspectState,
  flatFrameProjection,
} from "@/components/agent/teaching-inspect-state";

afterEach(cleanup);

const props = {
  canvas: null,
  onCancel: vi.fn(),
  onFreeze: vi.fn(),
  onHover: vi.fn(),
  projection: flatFrameProjection,
};

test("shows a selection failure only while picking", () => {
  const { rerender } = render(
    <InspectOverlay
      {...props}
      state={{ ...emptyInspectState, error: "No target", open: true }}
    />
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Try another visible element"
  );
  rerender(
    <InspectOverlay
      {...props}
      state={{ ...emptyInspectState, error: "No target" }}
    />
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

test("takes no pointer input outside a pick, so the Page stays usable under its pins", () => {
  const { container } = render(
    <InspectOverlay
      {...props}
      state={{
        ...emptyInspectState,
        comments: [
          {
            description: "button: Place order",
            height: 40,
            index: 1,
            width: 100,
            x: 20,
            y: 30,
          },
        ],
      }}
    />
  );
  // SAFETY: the overlay always renders its own root element.
  const layer = container.firstElementChild as Element;
  expect(layer.className).toContain("pointer-events-none");
  expect(layer).toHaveTextContent("1");
});

test("cancels a pick from its own pill", async () => {
  const user = userEvent.setup();
  const onCancel = vi.fn();
  render(
    <InspectOverlay
      {...props}
      onCancel={onCancel}
      state={{ ...emptyInspectState, open: true }}
    />
  );
  expect(screen.getByText("Click an element to attach it")).toBeVisible();
  await user.click(screen.getByRole("button", { name: /Cancel/u }));
  expect(onCancel).toHaveBeenCalledOnce();
});
