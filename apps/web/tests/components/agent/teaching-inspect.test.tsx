import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { InspectOverlay } from "@/components/agent/teaching-inspect";
import {
  emptyInspectState,
  flatFrameProjection,
} from "@/components/agent/teaching-inspect-state";

afterEach(cleanup);

const props = {
  canvas: null,
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

test("the pick hint takes no input, so a press on it picks what is underneath", () => {
  const onFreeze = vi.fn();
  const { container } = render(
    <InspectOverlay
      {...props}
      onFreeze={onFreeze}
      state={{ ...emptyInspectState, open: true }}
    />
  );
  const hint = screen.getByRole("status");
  expect(hint).toHaveTextContent(
    "Click an element to attach it to the comment"
  );
  expect(hint.className).toContain("pointer-events-none");
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByLabelText("Escape cancels")).toBeVisible();
  // SAFETY: the overlay always renders its own root element.
  const layer = container.firstElementChild as Element;
  fireEvent.pointerDown(hint, { clientX: 10, clientY: 10 });
  expect(onFreeze).toHaveBeenCalledOnce();
  expect(layer).toHaveAttribute("data-picking");
});
