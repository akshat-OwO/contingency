import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checkServer, mount, partAttrs, partState } from "@ui-sdk/core/testing";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import {
  DialogCombobox,
  DialogComboboxContent,
  DialogComboboxTitle,
  DialogComboboxTrigger,
  dialogCombobox,
} from "@/components/ui/dialog-combobox";
import type { DialogComboboxOpenChangeDetails } from "@/components/ui/dialog-combobox";

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

const Picker = ({
  defaultOpen,
  onOpenChange,
}: {
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (
    open: boolean,
    details: DialogComboboxOpenChangeDetails
  ) => void;
}) => (
  <DialogCombobox
    {...(defaultOpen === undefined ? {} : { defaultOpen })}
    {...(onOpenChange === undefined ? {} : { onOpenChange })}
  >
    <DialogComboboxTrigger aria-label="Agent Session">
      Checkout
    </DialogComboboxTrigger>
    <DialogComboboxContent aria-label="Agent Sessions">
      <DialogComboboxTitle>Agent Sessions</DialogComboboxTitle>
      <button type="button">Checkout · Dry Run</button>
    </DialogComboboxContent>
  </DialogCombobox>
);

test("renders the combobox's pure attributes on the server", () => {
  const html = checkServer(
    dialogCombobox,
    {},
    '<root><trigger as="button" aria-label="Agent Session">Checkout</trigger></root>'
  );
  expect(html).toContain('role="combobox"');
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain('aria-expanded="false"');

  const instance = dialogCombobox({ defaultOpen: true });
  try {
    const trigger = instance.part("trigger", {});
    expect(partAttrs(trigger)).toMatchObject({
      "aria-expanded": "true",
      "aria-haspopup": "dialog",
      role: "combobox",
    });
    expect(partState(trigger)).toEqual({ open: true });
  } finally {
    instance.destroy();
  }
});

test("ArrowDown and ArrowUp ask to open, other keys don't, and controlled state waits for its owner", async () => {
  const onOpenChange = vi.fn();
  const view = mount(
    dialogCombobox,
    { onOpenChange, open: false },
    '<root><trigger as="button" aria-label="Agent Session">Checkout</trigger></root>'
  );
  try {
    const trigger = view.root.querySelector<HTMLButtonElement>(
      '[data-slot="dialog-combobox-trigger"]'
    );
    expect(trigger).not.toBeNull();
    trigger?.focus();

    await view.keys("Enter");
    await view.keys("ArrowLeft");
    expect(onOpenChange).not.toHaveBeenCalled();

    await view.keys("ArrowDown");
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ reason: "arrow-key", source: "keyboard" })
    );
    // Controlled: the request is reported, and `open` waits for the owner.
    expect(view.state.open).toBe(false);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await view.keys("ArrowUp");
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
  }
});

test("opens a labelled dialog from ArrowDown, ArrowUp or a press, and Escape returns focus to the combobox", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(<Picker onOpenChange={onOpenChange} />);

  const combobox = screen.getByRole("combobox", { name: "Agent Session" });
  expect(combobox).toHaveAttribute("aria-haspopup", "dialog");
  expect(combobox).toHaveAttribute("aria-expanded", "false");
  expect(combobox.tagName).toBe("BUTTON");
  expect(screen.queryByRole("dialog")).toBeNull();

  combobox.focus();
  await user.keyboard("{ArrowDown}");
  const dialog = await screen.findByRole("dialog", { name: "Agent Sessions" });
  expect(combobox).toHaveAttribute("aria-expanded", "true");
  expect(combobox).toHaveAttribute("aria-controls", dialog.id);
  expect(onOpenChange).toHaveBeenLastCalledWith(
    true,
    expect.objectContaining({ reason: "arrow-key" })
  );

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(combobox).toHaveAttribute("aria-expanded", "false");
  expect(combobox).toHaveFocus();
  expect(onOpenChange).toHaveBeenLastCalledWith(
    false,
    expect.objectContaining({ reason: "escape-key" })
  );

  await user.keyboard("{ArrowUp}");
  await screen.findByRole("dialog", { name: "Agent Sessions" });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(combobox).toHaveFocus();

  await user.click(combobox);
  await screen.findByRole("dialog", { name: "Agent Sessions" });
  expect(onOpenChange).toHaveBeenLastCalledWith(
    true,
    expect.objectContaining({ reason: "trigger-press" })
  );
});

test("a canceled change keeps the dialog closed", async () => {
  const user = userEvent.setup();
  render(
    <Picker
      onOpenChange={(open, details) => {
        if (open) {
          details.cancel();
        }
      }}
    />
  );

  const combobox = screen.getByRole("combobox", { name: "Agent Session" });
  combobox.focus();
  await user.keyboard("{ArrowDown}");
  await user.click(combobox);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(combobox).toHaveAttribute("aria-expanded", "false");
});

const Controlled = () => {
  const [open, setOpen] = useState(false);
  return (
    <DialogCombobox open={open} onOpenChange={setOpen}>
      <DialogComboboxTrigger aria-label="Agent Session">
        Checkout
      </DialogComboboxTrigger>
      <DialogComboboxContent aria-label="Agent Sessions">
        <DialogComboboxTitle>Agent Sessions</DialogComboboxTitle>
        <button type="button" onClick={() => setOpen(false)}>
          Checkout · Dry Run
        </button>
      </DialogComboboxContent>
    </DialogCombobox>
  );
};

test("a controlled owner closes the dialog from inside it", async () => {
  const user = userEvent.setup();
  render(<Controlled />);

  const combobox = screen.getByRole("combobox", { name: "Agent Session" });
  combobox.focus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("dialog", { name: "Agent Sessions" });
  expect(combobox).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("button", { name: "Checkout · Dry Run" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(combobox).toHaveAttribute("aria-expanded", "false");
  expect(combobox).toHaveFocus();
});

test("a defaultOpen combobox starts with its dialog shown", async () => {
  render(<Picker defaultOpen />);
  await screen.findByRole("dialog", { name: "Agent Sessions" });
  expect(
    screen.getByRole("combobox", { name: "Agent Session" })
  ).toHaveAttribute("aria-expanded", "true");
});

const LabelledBy = () => (
  <DialogCombobox>
    <span id="session-label">Agent Session</span>
    <DialogComboboxTrigger aria-labelledby="session-label">
      Checkout
    </DialogComboboxTrigger>
  </DialogCombobox>
);

test("aria-labelledby names the trigger apart from the choice it shows", () => {
  render(<LabelledBy />);
  expect(
    screen.getByRole("combobox", { name: "Agent Session" })
  ).toHaveTextContent("Checkout");
});
