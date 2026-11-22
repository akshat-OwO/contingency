import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { RailButton } from "@/components/browser/inspector-rail";
import { Toggle, ToggleGroup } from "@/components/ui/toggle";
import { TooltipProvider } from "@/components/ui/tooltip";

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

const Pin = ({
  disabled = false,
  onPressedChange,
}: {
  readonly disabled?: boolean;
  readonly onPressedChange?: (pressed: boolean) => void;
}) => {
  const [pressed, setPressed] = useState(false);
  return (
    <Toggle
      disabled={disabled}
      onPressedChange={(next) => {
        setPressed(next);
        onPressedChange?.(next);
      }}
      pressed={pressed}
    >
      Pin
    </Toggle>
  );
};

test("a toggle reports its pressed state and keeps its name", async () => {
  const onPressedChange = vi.fn();
  const user = userEvent.setup();
  render(<Pin onPressedChange={onPressedChange} />);

  const pin = screen.getByRole("button", { name: "Pin" });
  expect(pin).toHaveAttribute("aria-pressed", "false");
  expect(pin).toHaveAttribute("type", "button");
  expect(pin).toHaveAttribute("data-slot", "toggle");
  expect(pin).not.toHaveAttribute("data-pressed");
  // A bare toggle takes the quiet island button look.
  expect(pin).toHaveClass("rounded-xl", "h-[34px]");

  await user.click(pin);
  expect(pin).toHaveAttribute("aria-pressed", "true");
  expect(pin).toHaveAttribute("data-pressed");
  expect(pin).toHaveAccessibleName("Pin");
  expect(onPressedChange).toHaveBeenLastCalledWith(true);

  pin.focus();
  await user.keyboard("{Enter}");
  expect(pin).toHaveAttribute("aria-pressed", "false");
  await user.keyboard(" ");
  expect(pin).toHaveAttribute("aria-pressed", "true");
  expect(onPressedChange).toHaveBeenCalledTimes(3);
});

test("a disabled toggle leaves the tab order and ignores presses", async () => {
  const onPressedChange = vi.fn();
  const user = userEvent.setup();
  render(<Pin disabled onPressedChange={onPressedChange} />);

  const pin = screen.getByRole("button", { name: "Pin" });
  expect(pin).toBeDisabled();
  expect(pin).toHaveAttribute("data-disabled");
  await user.click(pin);
  await user.tab();
  expect(pin).not.toHaveFocus();
  expect(onPressedChange).not.toHaveBeenCalled();
  expect(pin).toHaveAttribute("aria-pressed", "false");
});

test("an unstyled toggle draws only the classes it is given", () => {
  render(<Toggle aria-label="Console" className="size-9" variant="unstyled" />);
  const toggle = screen.getByRole("button", { name: "Console" });
  expect(toggle.className).toBe("size-9");
});

const Panels = ({
  onValueChange,
}: {
  readonly onValueChange: (value: string[]) => void;
}) => {
  const [value, setValue] = useState(["network"]);
  return (
    <>
      <button type="button">Before</button>
      <ToggleGroup
        aria-label="DevTools panels"
        deselectable={false}
        onValueChange={(next) => {
          setValue(next);
          onValueChange(next);
        }}
        value={value}
      >
        <Toggle value="console">Console</Toggle>
        <Toggle value="network">Network</Toggle>
        <Toggle disabled value="storage">
          Storage
        </Toggle>
      </ToggleGroup>
      <button type="button">After</button>
    </>
  );
};

test("a group is one tab stop, roves with the arrow keys, and keeps one toggle pressed", async () => {
  const onValueChange = vi.fn();
  const user = userEvent.setup();
  render(<Panels onValueChange={onValueChange} />);

  const group = screen.getByRole("group", { name: "DevTools panels" });
  expect(group).toHaveAttribute("data-slot", "toggle-group");
  const consoleToggle = screen.getByRole("button", { name: "Console" });
  const network = screen.getByRole("button", { name: "Network" });
  const storage = screen.getByRole("button", { name: "Storage" });

  // Tab enters on the pressed toggle, and leaves the group with one more.
  screen.getByRole("button", { name: "Before" }).focus();
  await user.tab();
  expect(network).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  await user.tab({ shift: true });
  expect(network).toHaveFocus();

  // Arrows move focus without pressing, reach a disabled toggle, and wrap.
  await user.keyboard("{ArrowRight}");
  expect(storage).toHaveFocus();
  expect(storage).toHaveAttribute("aria-disabled", "true");
  // Tab later returns to the toggle focused last, not the pressed one.
  await user.tab();
  await user.tab({ shift: true });
  expect(storage).toHaveFocus();
  expect(network).toHaveAttribute("aria-pressed", "true");
  await user.keyboard(" ");
  expect(storage).toHaveAttribute("aria-pressed", "false");
  await user.keyboard("{ArrowRight}");
  expect(consoleToggle).toHaveFocus();
  expect(onValueChange).not.toHaveBeenCalled();

  await user.keyboard("{Enter}");
  expect(onValueChange).toHaveBeenLastCalledWith(["console"]);
  expect(consoleToggle).toHaveAttribute("aria-pressed", "true");
  expect(network).toHaveAttribute("aria-pressed", "false");

  // Pressing the pressed toggle keeps it pressed.
  await user.click(consoleToggle);
  expect(consoleToggle).toHaveAttribute("aria-pressed", "true");
  expect(onValueChange).toHaveBeenCalledTimes(1);
});

test("a rail tool keeps its tooltip and toggles its surface", async () => {
  const onClick = vi.fn();
  const user = userEvent.setup();
  render(
    <TooltipProvider>
      <RailButton
        active={false}
        description="2 errors"
        icon={<svg />}
        label="Console"
        onClick={onClick}
      />
    </TooltipProvider>
  );

  const tool = screen.getByRole("button", { name: "Console" });
  expect(tool).toHaveAttribute("data-slot", "toggle");
  expect(tool).toHaveAttribute("aria-pressed", "false");
  expect(tool).toHaveAttribute("aria-description", "2 errors");

  await user.hover(tool);
  await waitFor(() => {
    expect(screen.getByRole("tooltip")).toHaveTextContent("Console");
  });
  await user.click(tool);
  expect(onClick).toHaveBeenCalledTimes(1);
  tool.focus();
  await user.keyboard("{Enter}");
  await user.keyboard(" ");
  expect(onClick).toHaveBeenCalledTimes(3);
});
