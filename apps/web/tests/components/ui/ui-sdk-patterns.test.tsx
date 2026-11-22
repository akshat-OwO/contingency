import type { AgentSessionSnapshot } from "@contingency/protocol";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checkPattern } from "@ui-sdk/core/testing";
import { afterEach, expect, test, vi } from "vitest";

import { DockSessionSelect } from "@/components/agent/workspace-dock";
import { WorkspaceHomeContext } from "@/components/agent/workspace-home-context";
import { WorkspaceHomeLink } from "@/components/agent/workspace-home-nav";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  FileInput,
  FileInputDropzone,
  FileInputTrigger,
} from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Radio, RadioGroup } from "@/components/ui/radio";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Tree,
  TreeGroup,
  TreeItem,
  TreeItemIndicator,
  TreeItemLabel,
} from "@/components/ui/tree";

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

test("the Agent Session picker is a listbox with its deletes beside it", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const onDelete = vi.fn();
  const browsing: AgentSessionSnapshot = {
    ...teaching,
    flowName: "browse-catalogue",
    id: "agent-two",
  };
  render(
    <DockSessionSelect
      deletion={{ error: undefined, onDelete, pending: false }}
      onSelect={onSelect}
      selectedSessionId={teaching.id}
      sessions={[teaching, browsing]}
    />
  );
  const trigger = screen.getByRole("combobox", { name: "Agent Session" });
  await user.click(trigger);
  const sessions = screen.getByRole("listbox", { name: "Agent Sessions" });
  // Choosing a session closes the picker, so `checkPattern`'s Space probe
  // can't stay on the list; tests/components/ui/listbox.test.tsx checks it.
  expect(within(sessions).getAllByRole("option")).toHaveLength(2);
  const shown = screen.getByRole("option", { name: "add-anvil" });
  const other = screen.getByRole("option", { name: "browse-catalogue" });
  expect(shown).toHaveAttribute("aria-selected", "true");
  expect(other).toHaveAttribute("aria-selected", "false");
  // Deletes are buttons outside the listbox, so it keeps only options.
  expect(sessions).not.toContainElement(
    screen.getByRole("button", { name: "Delete session add-anvil" })
  );

  // One tab stop: arrows browse without opening; Tab moves on to the deletes.
  shown.focus();
  await user.keyboard("{ArrowDown}");
  expect(other).toHaveFocus();
  expect(onSelect).not.toHaveBeenCalled();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "Delete session add-anvil" })
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onDelete).toHaveBeenCalledWith(teaching.id);
  expect(onSelect).not.toHaveBeenCalled();

  // Enter opens the browsed session and closes the picker.
  await user.click(other);
  expect(onSelect).toHaveBeenLastCalledWith(browsing.id);
  expect(screen.queryByRole("dialog", { name: "Agent Sessions" })).toBeNull();

  // Choosing the shown session closes the picker too.
  await user.click(trigger);
  await user.click(screen.getByRole("option", { name: "add-anvil" }));
  expect(onSelect).toHaveBeenLastCalledWith(teaching.id);
  expect(screen.queryByRole("dialog", { name: "Agent Sessions" })).toBeNull();
});

test("the Agent Session picker starts a new session on the Workspace home", async () => {
  const user = userEvent.setup();
  const goHome = vi.fn();
  render(
    <WorkspaceHomeContext value={{ goHome }}>
      <WorkspaceHomeLink wordmark />
      <DockSessionSelect
        onSelect={() => null}
        selectedSessionId={teaching.id}
        sessions={[teaching]}
      />
    </WorkspaceHomeContext>
  );
  // The top bar's wordmark is the session's link home.
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

test("facades composed from Button and Input keep their own slots", () => {
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
});

test("Collapsible discloses its content and keeps it mounted on request", async () => {
  const user = userEvent.setup();
  render(
    <Collapsible>
      <CollapsibleTrigger>Setup</CollapsibleTrigger>
      <CollapsibleContent keepMounted>
        <label>
          Done when element
          <input />
        </label>
      </CollapsibleContent>
    </Collapsible>
  );
  const trigger = screen.getByRole("button", { name: "Setup" });
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

test("RadioGroup follows the radio group pattern and keeps its slots", async () => {
  const user = userEvent.setup();
  const onValueChange = vi.fn();
  render(
    <RadioGroup
      aria-label="Starting data"
      defaultValue="keep"
      name="startingData"
      onValueChange={onValueChange}
    >
      <label>
        <Radio value="keep" />
        Keep current data
      </label>
      <label>
        <Radio value="clear" />
        Clear app data
      </label>
    </RadioGroup>
  );
  const group = screen.getByRole("radiogroup", { name: "Starting data" });
  expect(group).toHaveAttribute("data-slot", "radio-group");
  const keep = screen.getByRole("radio", { name: "Keep current data" });
  expect(keep).toHaveAttribute("data-slot", "radio");
  expect(keep).toBeChecked();
  expect(
    keep.querySelector('[data-slot="radio-indicator"]')
  ).toBeInTheDocument();
  await user.click(screen.getByText("Clear app data"));
  expect(onValueChange).toHaveBeenLastCalledWith("clear", expect.anything());
  const clear = screen.getByRole("radio", { name: "Clear app data" });
  expect(clear).toBeChecked();
  // checkPattern's arrow checks count the hidden native radios as stops in
  // jsdom, which has no layout, so the keys are driven here instead.
  await user.keyboard("{ArrowUp}");
  expect(keep).toHaveFocus();
  expect(keep).toBeChecked();
  const submitted = keep
    .closest("div")
    ?.querySelector<HTMLInputElement>(
      'input[type="radio"][name="startingData"]:checked'
    );
  expect(submitted?.value).toBe("keep");
});

test("SegmentedControl is a named radio group with a sliding thumb", async () => {
  const user = userEvent.setup();
  const onValueChange = vi.fn();
  render(
    <SegmentedControl
      aria-label="Camera permission"
      defaultValue="unchanged"
      onValueChange={onValueChange}
    >
      <SegmentedControlItem value="unchanged">Ask</SegmentedControlItem>
      <SegmentedControlItem value="grant">Grant</SegmentedControlItem>
      <SegmentedControlItem value="revoke">Deny</SegmentedControlItem>
    </SegmentedControl>
  );
  const control = screen.getByRole("radiogroup", { name: "Camera permission" });
  expect(control).toHaveAttribute("data-slot", "segmented-control");
  expect(
    control.querySelector('[data-slot="segmented-control-indicator"]')
  ).toBeInTheDocument();
  const ask = screen.getByRole("radio", { name: "Ask" });
  expect(ask).toHaveAttribute("data-slot", "segmented-control-item");
  expect(ask).toBeChecked();
  await user.click(screen.getByRole("radio", { name: "Deny" }));
  expect(onValueChange).toHaveBeenLastCalledWith("revoke", expect.anything());
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("radio", { name: "Grant" })).toHaveFocus();
  expect(screen.getByRole("radio", { name: "Grant" })).toBeChecked();
});

test("FileInput opens the picker from a named trigger inside its drop zone", async () => {
  // The native input is hidden from pointers; the trigger is what people use.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const onValueChange = vi.fn();
  render(
    <FileInput accept=".apk" onValueChange={onValueChange}>
      <FileInputDropzone>
        Drop an .apk here, or
        <FileInputTrigger>Upload an .apk</FileInputTrigger>
      </FileInputDropzone>
    </FileInput>
  );
  const trigger = screen.getByRole("button", { name: "Upload an .apk" });
  expect(trigger).toHaveAttribute("data-slot", "file-input-trigger");
  expect(trigger.closest('[data-slot="file-input-dropzone"]')).not.toBeNull();
  expect(trigger.closest('[data-slot="file-input"]')).not.toBeNull();
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(picker).toHaveAttribute("accept", ".apk");
  expect(picker).toHaveAttribute("tabindex", "-1");
  const apk = new File(["PK"], "shop.apk");
  await user.upload(picker ?? document.createElement("input"), apk);
  expect(onValueChange).toHaveBeenCalledWith([apk], expect.anything());
});

test("Tabs follow the tabs pattern and keep their slots", async () => {
  render(
    <Tabs defaultValue="flow.md">
      <TabsList aria-label="Flow files" variant="file">
        <TabsTrigger value="flow.md">flow.md</TabsTrigger>
        <TabsTrigger value="targets.md">targets.md</TabsTrigger>
      </TabsList>
      <TabsContent value="flow.md">Steps</TabsContent>
      <TabsContent value="targets.md">Targets</TabsContent>
    </Tabs>
  );
  const list = screen.getByRole("tablist", { name: "Flow files" });
  expect(list).toHaveAttribute("data-variant", "file");
  const first = screen.getByRole("tab", { name: "flow.md" });
  expect(first).toHaveAttribute("aria-selected", "true");
  expect(first).toHaveAttribute("data-selected");
  await checkPattern(list, "tabs");
  await userEvent.click(screen.getByRole("tab", { name: "targets.md" }));
  expect(
    screen.getByRole("tabpanel", { name: "targets.md" })
  ).toHaveTextContent("Targets");
});

test("Tabs default to segmented and follow the tabs pattern", async () => {
  render(
    <Tabs defaultValue="checks">
      <TabsList aria-label="Run Summary sections">
        <TabsTrigger value="checks">Checks</TabsTrigger>
        <TabsTrigger value="findings">Findings</TabsTrigger>
        <TabsTrigger value="task">Task</TabsTrigger>
      </TabsList>
      <TabsContent value="checks">Run checks</TabsContent>
      <TabsContent value="findings">No findings</TabsContent>
      <TabsContent value="task">The task</TabsContent>
    </Tabs>
  );
  const list = screen.getByRole("tablist", { name: "Run Summary sections" });
  expect(list).toHaveAttribute("data-variant", "segmented");
  expect(screen.getByRole("tab", { name: "Checks" })).toHaveAttribute(
    "data-selected"
  );
  await checkPattern(list, "tabs");
  await userEvent.click(screen.getByRole("tab", { name: "Task" }));
  expect(screen.getByRole("tabpanel", { name: "Task" })).toHaveTextContent(
    "The task"
  );
});

test("Tree follows the tree view pattern and marks branches", async () => {
  const onValueChange = vi.fn();
  render(
    <Tree
      aria-label="Local Flows"
      defaultExpanded={["shop"]}
      onValueChange={onValueChange}
    >
      <TreeItem value="shop">
        <TreeItemLabel>
          <TreeItemIndicator />
          shop
        </TreeItemLabel>
        <TreeGroup>
          <TreeItem value="cart-scan">
            <TreeItemLabel>cart-scan</TreeItemLabel>
          </TreeItem>
        </TreeGroup>
      </TreeItem>
      <TreeItem value="add-mug">
        <TreeItemLabel>add-mug</TreeItemLabel>
      </TreeItem>
    </Tree>
  );
  const tree = screen.getByRole("tree", { name: "Local Flows" });
  const branch = screen.getByRole("treeitem", { name: /shop/u });
  expect(branch).toHaveAttribute("aria-expanded", "true");
  await checkPattern(tree, "tree");
  await userEvent.click(screen.getByText("cart-scan"));
  expect(onValueChange.mock.lastCall?.[0]).toBe("cart-scan");
});

test("Checkbox is a named checkbox that reports its checked state", async () => {
  const user = userEvent.setup();
  const onCheckedChange = vi.fn();
  render(
    <label>
      <Checkbox onCheckedChange={onCheckedChange} />
      HttpOnly
    </label>
  );
  const box = screen.getByRole("checkbox", { name: "HttpOnly" });
  expect(box).toHaveAttribute("data-slot", "checkbox");
  expect(box).not.toBeChecked();
  await user.click(screen.getByText("HttpOnly"));
  expect(box).toBeChecked();
  expect(box).toHaveAttribute("data-checked");
  expect(onCheckedChange).toHaveBeenLastCalledWith(true, expect.anything());
  box.focus();
  await user.keyboard(" ");
  expect(box).not.toBeChecked();
});

test("a disabled Checkbox ignores presses", async () => {
  const user = userEvent.setup();
  render(
    <label>
      <Checkbox defaultChecked disabled />
      Secure
    </label>
  );
  const box = screen.getByRole("checkbox", { name: "Secure" });
  await user.click(screen.getByText("Secure"));
  expect(box).toBeChecked();
  expect(box).toHaveAttribute("data-disabled");
});

test("Field names its control and shows a rendered error", () => {
  render(
    <Field invalid>
      <FieldLabel>Name</FieldLabel>
      <Input />
      <FieldError>A cookie needs a name.</FieldError>
    </Field>
  );
  const input = screen.getByRole("textbox", { name: "Name" });
  expect(input).toHaveAccessibleDescription("A cookie needs a name.");
  expect(screen.getByRole("alert")).toHaveTextContent("A cookie needs a name.");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input.closest('[data-slot="field"]')).toHaveAttribute("data-invalid");
});

test("Textarea is a native multi-line textbox named by its Field", async () => {
  const user = userEvent.setup();
  render(
    <Field>
      <FieldLabel>Value</FieldLabel>
      <Textarea />
    </Field>
  );
  const textarea = screen.getByRole("textbox", { name: "Value" });
  expect(textarea.tagName).toBe("TEXTAREA");
  expect(textarea).toHaveAttribute("data-slot", "textarea");
  await user.type(textarea, "a{Enter}b");
  expect(textarea).toHaveValue("a\nb");
});
