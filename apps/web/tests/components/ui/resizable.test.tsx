import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import {
  Resizable,
  ResizableHandle,
  ResizablePanel,
} from "@/components/ui/resizable";
import type { ResizableHandleVariant } from "@/components/ui/resizable";
import { pixelShare, shareSize } from "@/components/ui/resizable-size";

import { stubResizableLayout } from "./resizable-layout";

declare global {
  var __UI_SDK_STRICT__: boolean | undefined;
}

let previousStrict: boolean | undefined;
let restoreLayout: (() => void) | undefined;

beforeAll(() => {
  previousStrict = globalThis.__UI_SDK_STRICT__;
  globalThis.__UI_SDK_STRICT__ = true;
});

afterAll(() => {
  globalThis.__UI_SDK_STRICT__ = previousStrict;
});

afterEach(() => {
  cleanup();
  restoreLayout?.();
  restoreLayout = undefined;
  vi.restoreAllMocks();
});

const Split = ({
  onLayoutChange,
  onLayoutCommit,
  orientation = "horizontal",
  variant,
}: {
  readonly onLayoutChange?: (
    layout: number[],
    details: { reason: string }
  ) => void;
  readonly onLayoutCommit?: (
    layout: number[],
    details: { reason: string }
  ) => void;
  readonly orientation?: "horizontal" | "vertical";
  readonly variant?: ResizableHandleVariant;
}) => (
  <Resizable
    orientation={orientation}
    {...(onLayoutChange === undefined ? {} : { onLayoutChange })}
    {...(onLayoutCommit === undefined ? {} : { onLayoutCommit })}
    step={2}
  >
    <ResizablePanel defaultSize={60} minSize="200px">
      Stage
    </ResizablePanel>
    <ResizableHandle
      aria-label="Resize DevTools"
      {...(variant === undefined ? {} : { variant })}
    />
    <ResizablePanel id="devtools" maxSize={70} minSize="220px">
      DevTools
    </ResizablePanel>
  </Resizable>
);

const separator = () =>
  screen.getByRole("separator", { name: "Resize DevTools" });

/** The group lays its panels out a microtask after they mount. */
const laidOut = async () => {
  await waitFor(() => {
    expect(separator()).toHaveAttribute("aria-valuenow");
  });
};

test("names the separator across the group and reports the first panel's share", async () => {
  restoreLayout = stubResizableLayout({ height: 600, width: 1000 });
  render(<Split />);
  await laidOut();

  const handle = separator();
  expect(handle).toHaveAttribute("aria-orientation", "vertical");
  expect(handle).toHaveAttribute("data-orientation", "horizontal");
  expect(handle).toHaveAttribute("aria-valuenow", "60");
  // The panel after it keeps 220px to 70%, so the first keeps 30% to 78%.
  expect(handle).toHaveAttribute("aria-valuemin", "30");
  expect(handle).toHaveAttribute("aria-valuemax", "78");
  expect(handle).toHaveAttribute("tabindex", "0");
  const stage = screen.getByText("Stage");
  expect(handle).toHaveAttribute("aria-controls", stage.id);
  expect(handle).toHaveAttribute("data-variant", "hairline");
  // The indicator is drawn, never read.
  expect(handle.firstElementChild).toHaveAttribute("aria-hidden", "true");
});

test("arrow keys along the axis move the handle by its step and stop at the bounds", async () => {
  restoreLayout = stubResizableLayout({ height: 600, width: 1000 });
  const onLayoutChange = vi.fn();
  const onLayoutCommit = vi.fn();
  const user = userEvent.setup();
  render(
    <Split onLayoutChange={onLayoutChange} onLayoutCommit={onLayoutCommit} />
  );
  await laidOut();

  const handle = separator();
  handle.focus();
  await user.keyboard("{ArrowRight}");
  expect(handle).toHaveAttribute("aria-valuenow", "62");
  expect(onLayoutChange).toHaveBeenLastCalledWith(
    [62, 38],
    expect.objectContaining({ reason: "step-key" })
  );
  expect(onLayoutCommit).toHaveBeenCalledTimes(1);

  await user.keyboard("{ArrowLeft}{ArrowLeft}");
  expect(handle).toHaveAttribute("aria-valuenow", "58");

  // Across the axis, the keys do nothing.
  await user.keyboard("{ArrowUp}{ArrowDown}");
  expect(handle).toHaveAttribute("aria-valuenow", "58");

  await user.keyboard("{End}");
  expect(handle).toHaveAttribute("aria-valuenow", "78");
  await user.keyboard("{Home}");
  expect(handle).toHaveAttribute("aria-valuenow", "30");
});

test("a vertical group moves with ArrowUp and ArrowDown", async () => {
  restoreLayout = stubResizableLayout({ height: 1000, width: 600 });
  const user = userEvent.setup();
  render(<Split orientation="vertical" variant="pill" />);
  await laidOut();

  const handle = separator();
  expect(handle).toHaveAttribute("aria-orientation", "horizontal");
  expect(handle).toHaveAttribute("data-orientation", "vertical");
  expect(handle).toHaveAttribute("data-variant", "pill");
  handle.focus();
  await user.keyboard("{ArrowDown}");
  expect(handle).toHaveAttribute("aria-valuenow", "62");
  await user.keyboard("{ArrowUp}{ArrowUp}");
  expect(handle).toHaveAttribute("aria-valuenow", "58");
  await user.keyboard("{ArrowLeft}{ArrowRight}");
  expect(handle).toHaveAttribute("aria-valuenow", "58");
});

test("a pointer drag moves the handle, stops at the bounds, and commits once", async () => {
  restoreLayout = stubResizableLayout({ height: 600, width: 1000 });
  const onLayoutChange = vi.fn();
  const onLayoutCommit = vi.fn();
  render(
    <Split onLayoutChange={onLayoutChange} onLayoutCommit={onLayoutCommit} />
  );
  await laidOut();

  const handle = separator();
  const pointer = {
    bubbles: true,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  };
  const at = (type: string, clientX: number, buttons: number) =>
    new PointerEvent(type, { ...pointer, buttons, clientX, clientY: 300 });
  act(() => {
    handle.dispatchEvent(at("pointerdown", 600, 1));
  });
  act(() => {
    document.dispatchEvent(at("pointermove", 500, 1));
  });
  await waitFor(() => {
    expect(handle).toHaveAttribute("aria-valuenow", "50");
  });
  expect(handle).toHaveAttribute("data-dragging");
  expect(onLayoutChange).toHaveBeenLastCalledWith(
    [50, 50],
    expect.objectContaining({ reason: "drag" })
  );

  // Past the stage's 200px minimum, the drag stops at the bound.
  act(() => {
    document.dispatchEvent(at("pointermove", 50, 1));
  });
  await waitFor(() => {
    expect(handle).toHaveAttribute("aria-valuenow", "30");
  });

  await act(async () => {
    document.dispatchEvent(at("pointerup", 50, 0));
    await Promise.resolve();
  });
  expect(handle).not.toHaveAttribute("data-dragging");
  expect(onLayoutCommit).toHaveBeenCalledTimes(1);
  expect(onLayoutCommit).toHaveBeenLastCalledWith(
    [30, 70],
    expect.objectContaining({ reason: "drag" })
  );
});

test("the layout stub puts jsdom's geometry back", () => {
  const restore = stubResizableLayout({ height: 600, width: 1000 });
  restore();
  expect(
    Object.hasOwn(HTMLElement.prototype, "getBoundingClientRect")
  ).toBeFalsy();
  const root = document.createElement("div");
  root.dataset.slot = "resizable";
  expect(root.getBoundingClientRect().width).toBe(0);
});

test("converts a size in pixels to a share of the room and back", () => {
  expect(pixelShare(432, 1080)).toBe(40);
  expect(shareSize(40, 1080)).toBe(432);
  expect(pixelShare(240, 0)).toBe(0);
  expect(pixelShare(2000, 1000)).toBe(100);
});
