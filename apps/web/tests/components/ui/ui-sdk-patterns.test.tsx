import type { AgentSessionSnapshot } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checkPattern } from "@ui-sdk/core/testing";
import { afterEach, expect, test } from "vitest";

import { DockSessionSelect } from "@/components/agent/workspace-dock";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Roles, names, slots and keys of each swapped facade primitive (#742). The
// UI SDK testing kit's `checkPattern` runs here only for non-modal popups:
// its tab-stop checks read layout, which jsdom does not have, so the modal
// dialog and select patterns are checked in a real browser instead.

afterEach(cleanup);

test("Select follows the select-only combobox pattern", async () => {
  render(
    <Select defaultValue="lax">
      <SelectTrigger aria-label="SameSite">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Policies</SelectLabel>
          <SelectItem value="strict">Strict</SelectItem>
          <SelectItem value="lax">Lax</SelectItem>
          <SelectItem value="none">None</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
  const trigger = screen.getByRole("combobox", { name: "SameSite" });
  expect(trigger).toHaveTextContent("Lax");
  expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
  trigger.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("option", { name: "Lax" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
});

test("Dialog follows the modal dialog pattern", async () => {
  render(
    <Dialog>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent>
        <DialogTitle>Apply the emulated location?</DialogTitle>
        <DialogDescription>Choose a decision.</DialogDescription>
        <button type="button">Apply</button>
      </DialogContent>
    </Dialog>
  );
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  const dialog = screen.getByRole("dialog", {
    name: "Apply the emulated location?",
  });
  expect(dialog).toHaveAttribute("data-slot", "dialog-content");
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveAccessibleDescription("Choose a decision.");
});

test("Sheet follows the modal dialog pattern and keeps its slots", async () => {
  render(
    <Sheet>
      <SheetTrigger>New Android session</SheetTrigger>
      <SheetContent>
        <SheetTitle>New Android session</SheetTitle>
        <SheetDescription>Pick a device.</SheetDescription>
        <button type="button">Start</button>
      </SheetContent>
    </Sheet>
  );
  await userEvent.click(
    screen.getByRole("button", { name: "New Android session" })
  );
  const sheet = screen.getByRole("dialog", { name: "New Android session" });
  expect(sheet).toHaveAttribute("data-slot", "sheet-content");
  expect(sheet).toHaveAttribute("data-side", "right");
  expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull();
  expect(sheet).toHaveAttribute("aria-modal", "true");
});

test("Popover opens a named dialog from its trigger", async () => {
  render(
    <Popover>
      <PopoverTrigger>Task details</PopoverTrigger>
      <PopoverContent>
        <PopoverTitle>Inspect the shop</PopoverTitle>
        <button type="button">Close details</button>
      </PopoverContent>
    </Popover>
  );
  await userEvent.click(screen.getByRole("button", { name: "Task details" }));
  const popover = screen.getByRole("dialog", { name: "Inspect the shop" });
  expect(popover).toHaveAttribute("data-slot", "popover-content");
  await checkPattern(popover, "dialog");
});

test("Tooltip names an icon trigger and describes a named one", async () => {
  render(
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger aria-label="Rotate viewport">R</TooltipTrigger>
        <TooltipContent>Rotate the device</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
  const trigger = screen.getByRole("button", { name: "Rotate viewport" });
  expect(trigger).toHaveAccessibleDescription("Rotate the device");
});

const session = (id: string, flowName: string) =>
  ({
    activity: "run",
    id,
    run: { kind: "task", purpose: { kind: "task", requestedTask: flowName } },
  }) as unknown as AgentSessionSnapshot;

test("the Agent Session combobox keeps its roles, names and keys", async () => {
  const sessions = [session("agent-a", "Add one anvil")];
  render(
    <DockSessionSelect
      onSelect={() => null}
      selectedSessionId={undefined}
      sessions={sessions}
    />
  );
  const trigger = screen.getByRole("combobox", { name: "Agent Session" });
  expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  trigger.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const picker = screen.getByRole("dialog", { name: "Agent Sessions" });
  expect(picker).toHaveAttribute("data-slot", "popover-content");
  await checkPattern(picker, "dialog");
  await userEvent.keyboard("{Escape}");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(trigger).toHaveFocus();
});
