import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { checkServer, mount, partAttrs, partState } from "@ui-sdk/core/testing";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DismissableLayer,
  dismissableLayer,
} from "@/components/ui/dismissable-layer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

afterEach(cleanup);

test("renders pure attributes and state on the server", () => {
  const html = checkServer(dismissableLayer, {}, "<root>Card</root>");
  expect(html).toContain('data-slot="dismissable-layer"');
  expect(html).toContain("data-open");

  const instance = dismissableLayer({});
  try {
    const root = instance.part("root", {});
    expect(partAttrs(root)).toMatchObject({ "data-open": "" });
    expect(partState(root)).toEqual({ open: true });
  } finally {
    instance.destroy();
  }
});

test("dismisses on Escape, ignores outside press by default, and cleans up on unmount", async () => {
  const outside = document.createElement("button");
  outside.type = "button";
  outside.textContent = "Outside";
  document.body.append(outside);

  const onDismiss = vi.fn();
  const view = mount(
    dismissableLayer,
    { onDismiss },
    "<root><button type='button'>Inside</button></root>"
  );
  try {
    await view.click(outside);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(view.state.open).toBe(true);

    await view.keys("Escape");
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(
      "escape-key",
      expect.objectContaining({
        reason: "escape-key",
        source: "keyboard",
      })
    );
    expect(view.state.open).toBe(false);
    expect(view.root).toHaveAttribute("data-closed");
  } finally {
    view.unmount();
    outside.remove();
  }

  // Unmounting removes the layer from the stack; later Escape keys do nothing.
  const secondDismiss = vi.fn();
  const ephemeral = mount(
    dismissableLayer,
    { onDismiss: secondDismiss },
    "<root>Ephemeral</root>"
  );
  ephemeral.unmount();
  document.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
  );
  expect(secondDismiss).not.toHaveBeenCalled();
});

test("supports outside-press opt-in, contains exclusions, and cancelable onDismiss", async () => {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.textContent = "Trigger";
  const outside = document.createElement("button");
  outside.type = "button";
  outside.textContent = "Outside";
  document.body.append(trigger, outside);

  let cancelNext = true;
  const onDismiss = vi.fn(
    (
      _reason: "escape-key" | "outside-press" | "window-blur",
      details: { cancel: () => void }
    ) => {
      if (cancelNext) {
        details.cancel();
      }
    }
  );
  const view = mount(
    dismissableLayer,
    {
      contains: (target) => trigger.contains(target),
      dismissOnOutsidePress: true,
      onDismiss,
    },
    "<root><button type='button'>Inside</button></root>"
  );
  try {
    await view.click(trigger);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(view.state.open).toBe(true);

    await view.click(outside);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenLastCalledWith(
      "outside-press",
      expect.objectContaining({ reason: "outside-press" })
    );
    expect(view.state.open).toBe(true);

    cancelNext = false;
    await view.click(outside);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(view.state.open).toBe(false);
  } finally {
    view.unmount();
    trigger.remove();
    outside.remove();
  }
});

test("stacked dismissable layers receive Escape from top to bottom", async () => {
  const outerDismiss = vi.fn();
  const innerDismiss = vi.fn();
  const outer = mount(
    dismissableLayer,
    { onDismiss: outerDismiss },
    "<root>Outer</root>"
  );
  const inner = mount(
    dismissableLayer,
    { onDismiss: innerDismiss },
    "<root>Inner</root>"
  );
  try {
    await inner.keys("Escape");
    expect(innerDismiss).toHaveBeenCalledTimes(1);
    expect(outerDismiss).not.toHaveBeenCalled();

    await outer.keys("Escape");
    expect(outerDismiss).toHaveBeenCalledTimes(1);
  } finally {
    inner.unmount();
    outer.unmount();
  }
});

test("nested Select, Combobox, Menu, and Dialog popups receive Escape before the outer DismissableLayer", async () => {
  const user = userEvent.setup();
  const onDismiss = vi.fn();

  const Harness = () => {
    const [open, setOpen] = useState(true);
    return open ? (
      <DismissableLayer
        onDismiss={() => {
          onDismiss();
          setOpen(false);
        }}
        render={<section aria-label="Surface" />}
      >
        <Select defaultValue="desktop">
          <SelectTrigger aria-label="Viewport">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="desktop">Desktop</SelectItem>
            <SelectItem value="phone">Phone</SelectItem>
          </SelectContent>
        </Select>
        <Combobox>
          <ComboboxInput aria-label="Target App" />
          <ComboboxContent>
            <ComboboxList>
              <ComboboxItem value="shop">Shop</ComboboxItem>
              <ComboboxItem value="cart">Cart</ComboboxItem>
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <DropdownMenu>
          <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Reset</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Dialog>
          <DialogTrigger>Confirm</DialogTrigger>
          <DialogContent>
            <DialogTitle>Confirm action</DialogTitle>
          </DialogContent>
        </Dialog>
      </DismissableLayer>
    ) : null;
  };

  render(<Harness />);

  // 1. Nested Select
  await user.click(screen.getByRole("combobox", { name: "Viewport" }));
  expect(await screen.findByRole("option", { name: "Phone" })).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("option", { name: "Phone" })).toBeNull();
  });
  expect(screen.getByRole("region", { name: "Surface" })).toBeVisible();
  expect(onDismiss).not.toHaveBeenCalled();

  // 2. Nested Combobox
  await user.click(screen.getByRole("combobox", { name: "Target App" }));
  expect(await screen.findByRole("option", { name: "Shop" })).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("option", { name: "Shop" })).toBeNull();
  });
  expect(screen.getByRole("region", { name: "Surface" })).toBeVisible();
  expect(onDismiss).not.toHaveBeenCalled();

  // 3. Nested DropdownMenu
  await user.click(screen.getByRole("button", { name: "Actions" }));
  expect(await screen.findByRole("menuitem", { name: "Reset" })).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menuitem", { name: "Reset" })).toBeNull();
  });
  expect(screen.getByRole("region", { name: "Surface" })).toBeVisible();
  expect(onDismiss).not.toHaveBeenCalled();

  // 4. Nested Dialog
  await user.click(screen.getByRole("button", { name: "Confirm" }));
  expect(
    await screen.findByRole("dialog", { name: "Confirm action" })
  ).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog", { name: "Confirm action" })).toBeNull();
  });
  expect(screen.getByRole("region", { name: "Surface" })).toBeVisible();
  expect(onDismiss).not.toHaveBeenCalled();

  // 5. Next Escape dismisses the outer DismissableLayer
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Surface" })).toBeNull();
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

const RestoreFocusHarness = () => {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)} type="button">
        Open card
      </button>
      <button type="button">Other control</button>
      {open ? (
        <DismissableLayer
          onDismiss={() => setOpen(false)}
          render={<section aria-label="Card" />}
          restoreFocus
        >
          <button onClick={() => setOpen(false)} type="button">
            Close card
          </button>
        </DismissableLayer>
      ) : null}
    </div>
  );
};

test("restoreFocus returns focus to the previously focused element or target only when focus was inside", async () => {
  const user = userEvent.setup();

  render(<RestoreFocusHarness />);
  const opener = screen.getByRole("button", { name: "Open card" });
  const other = screen.getByRole("button", { name: "Other control" });

  // Closing while focus is inside restores focus to the opener.
  await user.click(opener);
  await user.click(screen.getByRole("button", { name: "Close card" }));
  expect(opener).toHaveFocus();

  // Closing while focus is elsewhere leaves focus untouched.
  await user.click(opener);
  await user.click(other);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Card" })).toBeNull();
  expect(other).toHaveFocus();
});

test("controlled open={false} unregisters the layer and restores focus when configured", async () => {
  const user = userEvent.setup();
  const onDismiss = vi.fn();

  const Harness = () => {
    const [open, setOpen] = useState(true);
    return (
      <div>
        <button id="return-target" type="button">
          Rail button
        </button>
        <DismissableLayer
          onDismiss={() => {
            onDismiss();
            setOpen(false);
          }}
          open={open}
          render={<section aria-label="Panel" />}
          restoreFocus={() =>
            document.querySelector<HTMLElement>("#return-target")
          }
        >
          <button type="button">Inside action</button>
        </DismissableLayer>
      </div>
    );
  };

  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Inside action" }));
  expect(screen.getByRole("button", { name: "Inside action" })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Rail button" })).toHaveFocus();

  // Subsequent Escape while open={false} does not fire onDismiss again.
  await user.keyboard("{Escape}");
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("scope='focus-within' ignores Escape outside the layer without preventing fallthrough", async () => {
  const user = userEvent.setup();
  const outerDismiss = vi.fn();
  const scopedDismiss = vi.fn();
  const outsideKeyDown = vi.fn(
    (event: KeyboardEvent) => event.defaultPrevented
  );

  const Harness = () => {
    const [extraEl, setExtraEl] = useState<HTMLButtonElement | null>(null);
    return (
      <div>
        <DismissableLayer
          onDismiss={outerDismiss}
          render={<div aria-label="Outer" />}
        >
          <span>Background</span>
        </DismissableLayer>
        <button type="button">Outside control</button>
        <button ref={setExtraEl} type="button">
          Contained trigger
        </button>
        <DismissableLayer
          contains={(target) => extraEl?.contains(target) ?? false}
          onDismiss={scopedDismiss}
          render={<form aria-label="Scoped form" />}
          scope="focus-within"
        >
          <input aria-label="Flow name" />
          <Select defaultValue="desktop">
            <SelectTrigger aria-label="Viewport">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desktop">Desktop</SelectItem>
              <SelectItem value="phone">Phone</SelectItem>
            </SelectContent>
          </Select>
        </DismissableLayer>
      </div>
    );
  };

  render(<Harness />);

  // Focus outside the scoped layer: Escape falls through to the underlying
  // document-scoped layer, leaving the scoped layer open.
  const outside = screen.getByRole("button", { name: "Outside control" });
  await user.click(outside);
  await user.keyboard("{Escape}");
  expect(scopedDismiss).not.toHaveBeenCalled();
  expect(outerDismiss).toHaveBeenCalledTimes(1);

  // With no other layer active, an outside Escape is not defaultPrevented.
  document.addEventListener("keydown", outsideKeyDown);
  try {
    await user.keyboard("{Escape}");
  } finally {
    document.removeEventListener("keydown", outsideKeyDown);
  }
  expect(scopedDismiss).not.toHaveBeenCalled();
  expect(outsideKeyDown).toHaveBeenCalledWith(
    expect.objectContaining({ defaultPrevented: false, key: "Escape" })
  );

  // Inside the scoped form: nested popup closes first, then a second Escape
  // dismisses the scoped layer.
  await user.click(screen.getByRole("combobox", { name: "Viewport" }));
  expect(await screen.findByRole("option", { name: "Phone" })).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("option", { name: "Phone" })).toBeNull();
  });
  expect(scopedDismiss).not.toHaveBeenCalled();

  await user.keyboard("{Escape}");
  expect(scopedDismiss).toHaveBeenCalledTimes(1);
});

test("scope='focus-within' treats elements matched by contains as inside the layer", async () => {
  const user = userEvent.setup();
  const onDismiss = vi.fn();

  const Harness = () => {
    const [triggerEl, setTriggerEl] = useState<HTMLButtonElement | null>(null);
    return (
      <div>
        <button ref={setTriggerEl} type="button">
          Linked trigger
        </button>
        <DismissableLayer
          contains={(target) => triggerEl?.contains(target) ?? false}
          onDismiss={onDismiss}
          render={<section aria-label="Scoped" />}
          scope="focus-within"
        >
          <input aria-label="Field" />
        </DismissableLayer>
      </div>
    );
  };

  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Linked trigger" }));
  await user.keyboard("{Escape}");
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("already-open child Dialog mounted in the same render receives Escape before its parent DismissableLayer", async () => {
  const user = userEvent.setup();
  const outerDismiss = vi.fn();

  const Harness = () => {
    const [open, setOpen] = useState(true);
    return open ? (
      <DismissableLayer
        onDismiss={() => {
          outerDismiss();
          setOpen(false);
        }}
        render={<section aria-label="Surface" />}
      >
        <Dialog defaultOpen>
          <DialogContent>
            <DialogTitle>Confirm on mount</DialogTitle>
          </DialogContent>
        </Dialog>
      </DismissableLayer>
    ) : null;
  };

  render(<Harness />);
  expect(
    screen.getByRole("dialog", { name: "Confirm on mount" })
  ).toBeVisible();

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Confirm on mount" })
    ).toBeNull();
  });
  expect(screen.getByRole("region", { name: "Surface" })).toBeVisible();
  expect(outerDismiss).not.toHaveBeenCalled();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Surface" })).toBeNull();
  expect(outerDismiss).toHaveBeenCalledTimes(1);
});

test("nested DismissableLayers mounted in the same render dismiss inner before outer", async () => {
  const user = userEvent.setup();
  const outerDismiss = vi.fn();
  const innerDismiss = vi.fn();

  const Harness = () => {
    const [outerOpen, setOuterOpen] = useState(true);
    const [innerOpen, setInnerOpen] = useState(true);
    return outerOpen ? (
      <DismissableLayer
        onDismiss={() => {
          outerDismiss();
          setOuterOpen(false);
        }}
        render={<section aria-label="Outer surface" />}
      >
        {innerOpen ? (
          <DismissableLayer
            onDismiss={() => {
              innerDismiss();
              setInnerOpen(false);
            }}
            render={<section aria-label="Inner surface" />}
          >
            <button type="button">Inner action</button>
          </DismissableLayer>
        ) : null}
      </DismissableLayer>
    ) : null;
  };

  render(<Harness />);
  await user.keyboard("{Escape}");
  expect(innerDismiss).toHaveBeenCalledTimes(1);
  expect(outerDismiss).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Outer surface" })).toBeVisible();

  await user.keyboard("{Escape}");
  expect(outerDismiss).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("region", { name: "Outer surface" })).toBeNull();
});
