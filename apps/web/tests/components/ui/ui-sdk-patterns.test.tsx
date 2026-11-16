import type { AgentSessionSnapshot } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checkPattern } from "@ui-sdk/core/testing";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import {
  DockSessionSelect,
  DockWordmark,
} from "@/components/agent/workspace-dock";
import { WorkspaceHomeContext } from "@/components/agent/workspace-home-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
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
  // The group keeps its name while its label stays out of the tree.
  const group = screen.getByRole("group", { name: "Policies" });
  expect(group.querySelector('[data-slot="select-label"]')).toHaveAttribute(
    "aria-hidden",
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

const EraseOverSheet = () => {
  const [open, setOpen] = useState(false);
  return (
    <Sheet defaultOpen>
      <SheetContent>
        <SheetTitle>New Android session</SheetTitle>
        <button onClick={() => setOpen(true)} type="button">
          Erase Pixel_9
        </button>
      </SheetContent>
      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogTitle>Erase Pixel_9?</AlertDialogTitle>
          <AlertDialogDescription>It cannot be undone.</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
};

test("an alert dialog opened over a Sheet joins the Sheet's top layer", async () => {
  // A body-portalled confirmation sits under a top-layer Sheet and its
  // backdrop, so Device Erase could not be answered. jsdom has no stacking;
  // a real-browser check covered the pointer path, and this keeps the
  // confirmation on the same top layer as the Sheet.
  render(<EraseOverSheet />);
  const sheet = screen.getByRole("dialog", { name: "New Android session" });
  await userEvent.click(screen.getByRole("button", { name: "Erase Pixel_9" }));
  const confirmation = screen.getByRole("alertdialog", {
    name: "Erase Pixel_9?",
  });
  expect(confirmation).toHaveAttribute("data-slot", "alert-dialog-content");
  expect(confirmation).toHaveAttribute("aria-modal", "true");
  expect(confirmation).toHaveAccessibleDescription("It cannot be undone.");
  expect(sheet).toHaveAttribute("popover");
  expect(confirmation).toHaveAttribute("popover");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.queryByRole("alertdialog", { name: "Erase Pixel_9?" })
  ).toBeNull();
  expect(sheet).toBeInTheDocument();
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

test("Tooltip names an icon trigger and describes a named one", () => {
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

type TeachingSnapshot = Extract<
  AgentSessionSnapshot,
  { readonly activity: "teaching" }
>;

/** A Teaching session the picker labels by its Flow name. */
const teaching: AgentSessionSnapshot = {
  activity: "teaching",
  captureState: { _tag: "setup" },
  clientName: "Test agent",
  clientVersion: "1.0",
  controller: "user",
  createdAt: "2026-09-18T00:00:00.000Z",
  currentUrl: "https://example.com/",
  flowName: "add-anvil",
  id: "agent-one",
  interruptedAction: null,
  ownerProcessId: "mcp-test",
  phase: "running",
  recordingId: "recording-39cd",
  run: null,
  takeover: null,
  teaching: { actionCount: 0, instructionCount: 0, instructions: [] },
  timeline: [],
  updatedAt: "2026-09-18T00:00:00.000Z",
  verification: null,
  viewUrl: "http://127.0.0.1:7777/?session=agent-one",
} satisfies TeachingSnapshot;

test("the Agent Session combobox keeps its roles, names and keys", async () => {
  render(
    <DockSessionSelect
      onSelect={() => null}
      selectedSessionId={undefined}
      sessions={[teaching]}
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

test("the Agent Session picker starts a new session on the Workspace home", async () => {
  const user = userEvent.setup();
  const goHome = vi.fn();
  render(
    <WorkspaceHomeContext value={{ goHome }}>
      <DockWordmark />
      <DockSessionSelect
        onSelect={() => null}
        selectedSessionId={teaching.id}
        sessions={[teaching]}
      />
    </WorkspaceHomeContext>
  );
  // The logo mark is the dock's link home.
  const home = screen.getByRole("link", { name: "Contingency home" });
  expect(home).toHaveAttribute("href", "/");
  await user.click(home);
  expect(goHome).toHaveBeenCalledTimes(1);

  const trigger = screen.getByRole("combobox", { name: "Agent Session" });
  await user.click(trigger);
  await user.click(
    screen.getByRole("button", { exact: true, name: "New session" })
  );
  expect(goHome).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog", { name: "Agent Sessions" })).toBeNull();

  // The extra action keeps the picker a well-formed dialog.
  await user.click(trigger);
  await checkPattern(
    screen.getByRole("dialog", { name: "Agent Sessions" }),
    "dialog"
  );
});

test("without a way home the picker offers no New session", async () => {
  const user = userEvent.setup();
  render(
    <DockSessionSelect
      onSelect={() => null}
      selectedSessionId={undefined}
      sessions={[teaching]}
    />
  );
  await user.click(screen.getByRole("combobox", { name: "Agent Session" }));
  expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
});

test("Button is a native button that a promise does not make busy", async () => {
  const user = userEvent.setup();
  const presses: string[] = [];
  render(
    <Button onClick={() => Promise.resolve(presses.push("pressed"))}>
      Save
    </Button>
  );
  const button = screen.getByRole("button", { name: "Save" });
  expect(button.tagName).toBe("BUTTON");
  expect(button).toHaveAttribute("type", "button");
  expect(button).toHaveAttribute("data-slot", "button");

  await user.click(button);
  button.focus();
  await user.keyboard("{Enter}");
  await user.keyboard(" ");

  expect(presses).toEqual(["pressed", "pressed", "pressed"]);
  expect(button).not.toHaveAttribute("aria-busy");
  expect(button).not.toHaveAttribute("aria-disabled");
});

test("a disabled Button ignores presses and leaves the tab order", async () => {
  const user = userEvent.setup();
  const presses: string[] = [];
  render(
    <Button disabled onClick={() => presses.push("pressed")}>
      Save
    </Button>
  );
  const button = screen.getByRole("button", { name: "Save" });
  expect(button).toBeDisabled();
  await user.click(button);
  await user.tab();
  expect(button).not.toHaveFocus();
  expect(presses).toEqual([]);
});

test("Input is a native textbox with its slot", async () => {
  const user = userEvent.setup();
  render(<Input aria-label="Flow name" defaultValue="new-flow" />);
  const input = screen.getByRole("textbox", { name: "Flow name" });
  expect(input).toHaveAttribute("data-slot", "input");
  await user.clear(input);
  await user.type(input, "checkout");
  expect(input).toHaveValue("checkout");
});

test("facades composed from Button and Input keep their own slots", async () => {
  render(
    <>
      <InputGroup>
        <InputGroupInput aria-label="Browser address" />
      </InputGroup>
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>Erase Pixel_9?</AlertDialogTitle>
          <AlertDialogAction>Erase</AlertDialogAction>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
      <Sheet defaultOpen>
        <SheetContent>
          <SheetTitle>New Android session</SheetTitle>
        </SheetContent>
      </Sheet>
    </>
  );
  expect(
    screen.getByRole("textbox", { name: "Browser address" })
  ).toHaveAttribute("data-slot", "input-group-control");
  expect(screen.getByRole("button", { name: "Erase" })).toHaveAttribute(
    "data-slot",
    "alert-dialog-action"
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute(
    "data-slot",
    "alert-dialog-cancel"
  );
  expect(
    await screen.findByRole("button", { hidden: true, name: "Close" })
  ).toHaveAttribute("data-slot", "sheet-close");
});

test("Collapsible discloses its content and keeps it mounted on request", async () => {
  const user = userEvent.setup();
  render(
    <Collapsible>
      <CollapsibleTrigger>Optional steps</CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <label>
          Done when element
          <input />
        </label>
      </CollapsibleContent>
    </Collapsible>
  );
  const trigger = screen.getByRole("button", { name: "Optional steps" });
  expect(trigger).toHaveAttribute("data-slot", "collapsible-trigger");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.getByLabelText("Done when element", { selector: "input" })
  ).not.toBeVisible();

  trigger.focus();
  await user.keyboard("{Enter}");

  expect(trigger).toHaveAttribute("aria-expanded", "true");
  expect(trigger).toHaveAttribute("data-open");
  const panel = document.querySelector('[data-slot="collapsible-content"]');
  expect(trigger.getAttribute("aria-controls")).toBe(panel?.id);
  expect(
    screen.getByRole("textbox", { name: "Done when element" })
  ).toBeVisible();
});
