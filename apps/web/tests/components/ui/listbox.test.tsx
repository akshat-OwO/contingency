import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checkPattern } from "@ui-sdk/core/testing";
import { Fragment, useState } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import {
  Listbox,
  ListboxGroup,
  ListboxGroupLabel,
  ListboxItem,
  ListboxItemIndicator,
  ListboxSeparator,
} from "@/components/ui/listbox";

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

const produce = [
  {
    items: [
      { label: "Apple", value: "apple" },
      { label: "Banana", value: "banana" },
    ],
    label: "Fruits",
  },
  {
    items: [
      { label: "Carrot", value: "carrot" },
      { disabled: true, label: "Broccoli", value: "broccoli" },
      { label: "Spinach", value: "spinach" },
    ],
    label: "Vegetables",
  },
];

const Produce = ({
  activation,
  disabled = false,
  onValueChange,
}: {
  readonly activation: "automatic" | "manual";
  readonly disabled?: boolean;
  readonly onValueChange: (value: string | null) => void;
}) => {
  const [value, setValue] = useState<string | null>("banana");
  return (
    <>
      <button type="button">Before</button>
      <Listbox
        activation={activation}
        aria-label="Produce"
        disabled={disabled}
        onValueChange={(next) => {
          setValue(next);
          onValueChange(next);
        }}
        value={value}
      >
        {produce.map((group, index) => (
          <Fragment key={group.label}>
            {index > 0 && <ListboxSeparator />}
            <ListboxGroup>
              <ListboxGroupLabel>{group.label}</ListboxGroupLabel>
              {group.items.map((item) => (
                <ListboxItem
                  disabled={"disabled" in item && item.disabled}
                  key={item.value}
                  value={item.value}
                >
                  {item.label}
                  <ListboxItemIndicator>✓</ListboxItemIndicator>
                </ListboxItem>
              ))}
            </ListboxGroup>
          </Fragment>
        ))}
      </Listbox>
    </>
  );
};

test("follows the WAI-ARIA listbox pattern, with named groups", async () => {
  render(<Produce activation="manual" onValueChange={vi.fn()} />);
  const list = screen.getByRole("listbox", { name: "Produce" });
  await checkPattern(list, "listbox");

  expect(list).toHaveAttribute("data-slot", "listbox");
  expect(screen.getByRole("group", { name: "Fruits" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Vegetables" })).toBeInTheDocument();
  const banana = screen.getByRole("option", { name: "Banana" });
  expect(banana).toHaveAttribute("aria-selected", "true");
  expect(banana).toHaveAttribute("data-selected");
  expect(screen.getByRole("option", { name: "Apple" })).toHaveAttribute(
    "aria-selected",
    "false"
  );
  // The separator is drawn, never read.
  expect(screen.queryByRole("separator")).toBeNull();
});

test("manual activation browses with the keys and chooses on Enter, Space or a press", async () => {
  const onValueChange = vi.fn();
  const user = userEvent.setup();
  render(<Produce activation="manual" onValueChange={onValueChange} />);

  // Tab enters on the chosen option, the list's one tab stop.
  screen.getByRole("button", { name: "Before" }).focus();
  await user.tab();
  const banana = screen.getByRole("option", { name: "Banana" });
  expect(banana).toHaveFocus();

  // Arrows cross into the next group and skip the disabled option.
  await user.keyboard("{ArrowDown}");
  const carrot = screen.getByRole("option", { name: "Carrot" });
  expect(carrot).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: "Spinach" })).toHaveFocus();
  await user.keyboard("{Home}");
  expect(screen.getByRole("option", { name: "Apple" })).toHaveFocus();
  await user.keyboard("{End}");
  expect(screen.getByRole("option", { name: "Spinach" })).toHaveFocus();
  // Typing moves to the option that starts with it.
  await user.keyboard("c");
  expect(carrot).toHaveFocus();
  expect(onValueChange).not.toHaveBeenCalled();

  await user.keyboard("{Enter}");
  expect(onValueChange).toHaveBeenLastCalledWith("carrot");
  expect(carrot).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{ArrowUp} ");
  expect(onValueChange).toHaveBeenLastCalledWith("banana");
  await user.click(screen.getByRole("option", { name: "Apple" }));
  expect(onValueChange).toHaveBeenLastCalledWith("apple");

  // A disabled option can't be chosen.
  await user.click(screen.getByRole("option", { name: "Broccoli" }));
  expect(onValueChange).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("option", { name: "Broccoli" })).toHaveAttribute(
    "aria-disabled",
    "true"
  );
});

test("automatic activation chooses as focus moves", async () => {
  const onValueChange = vi.fn();
  const user = userEvent.setup();
  render(<Produce activation="automatic" onValueChange={onValueChange} />);

  screen.getByRole("option", { name: "Banana" }).focus();
  await user.keyboard("{ArrowDown}");
  expect(onValueChange).toHaveBeenLastCalledWith("carrot");
  expect(screen.getByRole("option", { name: "Carrot" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

test("a disabled list leaves the tab order and chooses nothing", async () => {
  const onValueChange = vi.fn();
  const user = userEvent.setup();
  render(
    <Produce activation="manual" disabled onValueChange={onValueChange} />
  );

  const list = screen.getByRole("listbox", { name: "Produce" });
  expect(list).toHaveAttribute("aria-disabled", "true");
  expect(list).toHaveAttribute("data-disabled");
  screen.getByRole("button", { name: "Before" }).focus();
  await user.tab();
  expect(document.body).toHaveFocus();
  await user.click(screen.getByRole("option", { name: "Apple" }));
  expect(onValueChange).not.toHaveBeenCalled();
});
