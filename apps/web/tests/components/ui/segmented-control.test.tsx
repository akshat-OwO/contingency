import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import {
  createSegmentedControlController,
  SegmentedControl,
  SegmentedControlCount,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import type {
  SegmentedControlController,
  SegmentedControlSize,
} from "@/components/ui/segmented-control";

declare global {
  var __UI_SDK_STRICT__: boolean | undefined;
}

let previousStrict: boolean | undefined;

beforeAll(() => {
  previousStrict = globalThis.__UI_SDK_STRICT__;
  globalThis.__UI_SDK_STRICT__ = true;
});

afterAll(() => {
  globalThis.__UI_SDK_STRICT__ = previousStrict;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Scheme = "dark" | "light" | "none";

const SchemeControl = ({
  controller,
  disabled = false,
  initial = "none",
  onValueChange = () => null,
  size,
}: {
  readonly controller?: SegmentedControlController;
  readonly disabled?: boolean;
  readonly initial?: Scheme | null;
  readonly onValueChange?: (value: Scheme | null) => void;
  readonly size?: SegmentedControlSize;
}) => {
  const [value, setValue] = useState<Scheme | null>(initial);
  return (
    <>
      <button type="button">Before</button>
      <SegmentedControl<Scheme>
        aria-label="Color scheme"
        {...(controller === undefined ? {} : { controller })}
        disabled={disabled}
        onValueChange={(next) => {
          setValue(next);
          onValueChange(next);
        }}
        {...(size === undefined ? {} : { size })}
        value={value}
      >
        <SegmentedControlItem value="none">No preference</SegmentedControlItem>
        <SegmentedControlItem value="light">Light</SegmentedControlItem>
        <SegmentedControlItem value="dark">Dark</SegmentedControlItem>
      </SegmentedControl>
    </>
  );
};

// `checkPattern(group, "radio-group")` doesn't fit this part: UI SDK pairs
// each segment with a hidden form radio, which the probe counts as a second
// checked radio. The keyboard tests below cover the pattern instead.
test("is a named radio group with its slots", () => {
  render(<SchemeControl />);
  const group = screen.getByRole("radiogroup", { name: "Color scheme" });
  expect(group).toHaveAttribute("aria-orientation", "horizontal");
  expect(group).toHaveAttribute("data-slot", "segmented-control");
  expect(
    group.querySelector('[data-slot="segmented-control-indicator"]')
  ).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "No preference" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "Light" })).not.toBeChecked();
});

test("a compact control is one tab stop whose arrows, Home and End move and check", async () => {
  const onValueChange = vi.fn();
  const user = userEvent.setup();
  render(<SchemeControl onValueChange={onValueChange} size="sm" />);

  screen.getByRole("button", { name: "Before" }).focus();
  await user.tab();
  expect(screen.getByRole("radio", { name: "No preference" })).toHaveFocus();
  expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute(
    "tabindex",
    "-1"
  );
  await user.keyboard("{ArrowRight}");
  const light = screen.getByRole("radio", { name: "Light" });
  expect(light).toHaveFocus();
  expect(light).toBeChecked();
  expect(onValueChange).toHaveBeenLastCalledWith("light");
  await user.keyboard("{End}");
  expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("radio", { name: "No preference" })).toHaveFocus();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  await user.keyboard("{Home}");
  expect(screen.getByRole("radio", { name: "No preference" })).toBeChecked();
  await user.keyboard("{ArrowDown}");
  expect(light).toBeChecked();
  await user.keyboard("{ArrowUp}");
  expect(screen.getByRole("radio", { name: "No preference" })).toBeChecked();
});

test("Enter presses the focused compact segment, even with nothing checked", async () => {
  const onValueChange = vi.fn();
  const user = userEvent.setup();
  render(
    <SchemeControl initial={null} onValueChange={onValueChange} size="xs" />
  );
  screen.getByRole("button", { name: "Before" }).focus();
  await user.tab();
  expect(screen.getByRole("radio", { name: "No preference" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onValueChange).toHaveBeenLastCalledWith("none");
  expect(screen.getByRole("radio", { name: "No preference" })).toBeChecked();
});

test("the island size keeps UI SDK's keys: Enter and Home check nothing", async () => {
  const onValueChange = vi.fn();
  const user = userEvent.setup();
  render(<SchemeControl initial="light" onValueChange={onValueChange} />);
  screen.getByRole("radio", { name: "Light" }).focus();
  await user.keyboard("{Home}{Enter}");
  expect(onValueChange).not.toHaveBeenCalled();
  expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
});

test("a controller that clears the value tells the consumer", () => {
  const onValueChange = vi.fn();
  const controller = createSegmentedControlController();
  render(
    <SchemeControl
      controller={controller}
      onValueChange={onValueChange}
      size="sm"
    />
  );
  act(() => {
    controller.setValue(null);
  });
  expect(onValueChange).toHaveBeenLastCalledWith(null);
  for (const radio of screen.getAllByRole("radio")) {
    expect(radio).not.toBeChecked();
  }
});

test("swaps Left and Right in a right-to-left layout", async () => {
  const user = userEvent.setup();
  render(
    <div dir="rtl" style={{ direction: "rtl" }}>
      <SchemeControl />
    </div>
  );
  screen.getByRole("radio", { name: "No preference" }).focus();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
  await user.keyboard("{ArrowRight}");
  expect(screen.getByRole("radio", { name: "No preference" })).toBeChecked();
});

test("enters on the first segment while nothing is checked", async () => {
  const user = userEvent.setup();
  render(<SchemeControl initial={null} />);
  for (const radio of screen.getAllByRole("radio")) {
    expect(radio).not.toBeChecked();
  }
  screen.getByRole("button", { name: "Before" }).focus();
  await user.tab();
  expect(screen.getByRole("radio", { name: "No preference" })).toHaveFocus();
});

test("a disabled control leaves the tab order and checks nothing", async () => {
  const onValueChange = vi.fn();
  const user = userEvent.setup();
  render(<SchemeControl disabled onValueChange={onValueChange} />);
  const group = screen.getByRole("radiogroup", { name: "Color scheme" });
  expect(group).toHaveAttribute("data-disabled");
  for (const radio of screen.getAllByRole("radio")) {
    expect(radio).toHaveAttribute("aria-disabled", "true");
    expect(radio).toHaveAttribute("tabindex", "-1");
  }
  screen.getByRole("button", { name: "Before" }).focus();
  await user.tab();
  expect(document.body).toHaveFocus();
  await user.click(screen.getByRole("radio", { name: "Dark" }));
  expect(onValueChange).not.toHaveBeenCalled();
  expect(screen.getByRole("radio", { name: "No preference" })).toBeChecked();
});

test.each([
  ["default", "h-7", "bg-island-solid"],
  ["sm", "h-6", "bg-background"],
  ["xs", "h-5", "bg-background"],
] as const)(
  "the %s size draws its segments and thumb",
  (size, height, thumb) => {
    render(<SchemeControl size={size} />);
    const group = screen.getByRole("radiogroup", { name: "Color scheme" });
    expect(group).toHaveAttribute("data-size", size);
    expect(screen.getByRole("radio", { name: "Light" })).toHaveClass(height);
    expect(
      group.querySelector('[data-slot="segmented-control-indicator"]')
    ).toHaveClass(thumb);
  }
);

test("a count is part of its segment's name, as before", () => {
  render(
    <SegmentedControl aria-label="Console level" size="sm" value="all">
      <SegmentedControlItem value="all">
        All
        <SegmentedControlCount>12</SegmentedControlCount>
      </SegmentedControlItem>
      <SegmentedControlItem value="error">
        Errors
        <SegmentedControlCount>3</SegmentedControlCount>
      </SegmentedControlItem>
    </SegmentedControl>
  );
  expect(screen.getByRole("radio", { name: "Errors3" })).toHaveAttribute(
    "data-slot",
    "segmented-control-item"
  );
  expect(screen.getByText("12")).toHaveAttribute(
    "data-slot",
    "segmented-control-count"
  );
});
