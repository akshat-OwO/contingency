"use client";

import { usePart, usePrimitive } from "@ui-sdk/react/primitive";
import type { PartProps } from "@ui-sdk/react/primitive";
import type * as React from "react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import { dialogCombobox } from "./dialog-combobox-primitive";
import type {
  DialogComboboxOptions,
  DialogComboboxState,
} from "./dialog-combobox-primitive";

export type DialogComboboxProps = DialogComboboxOptions & {
  readonly children?: React.ReactNode;
};

/**
 * A combobox that opens a dialog: the Popover handles placement, dismissal and
 * focus, and this owns `open` so ArrowDown and ArrowUp can open it too.
 */
const DialogCombobox = ({
  children,
  debug,
  defaultOpen,
  onOpenChange,
  open,
}: DialogComboboxProps) => {
  const baseOptions: DialogComboboxOptions = {
    defaultOpen,
    onOpenChange,
    open,
  };
  const handle = usePrimitive(
    dialogCombobox,
    debug === undefined ? baseOptions : { ...baseOptions, debug }
  );

  return usePart(
    handle,
    "root",
    {},
    {
      render: (_props, state: DialogComboboxState) => (
        <Popover
          open={state.open}
          onOpenChange={(next, { event, reason, source }) => {
            handle.api.setOpen(next, { event, reason, source });
          }}
        >
          {children}
        </Popover>
      ),
    }
  );
};

export type DialogComboboxTriggerProps = Omit<
  PartProps<"button", DialogComboboxState>,
  "render"
> & {
  /** The element to render, as on `PopoverTrigger`, like a `Button`. */
  readonly render?: NonNullable<
    React.ComponentProps<typeof PopoverTrigger>["render"]
  >;
};

/** The combobox, rendered through the Popover's trigger. */
const DialogComboboxTrigger = ({
  render,
  ...props
}: DialogComboboxTriggerProps) =>
  usePart(
    dialogCombobox,
    "trigger",
    {},
    {
      ...props,
      render: <PopoverTrigger {...(render === undefined ? {} : { render })} />,
    },
    "button"
  );

const DialogComboboxContent = (
  props: React.ComponentProps<typeof PopoverContent>
) => <PopoverContent align="start" {...props} />;

export { DialogCombobox, DialogComboboxContent, DialogComboboxTrigger };
export { PopoverTitle as DialogComboboxTitle } from "@/components/ui/popover";
export { dialogCombobox } from "./dialog-combobox-primitive";
export type {
  DialogComboboxChange,
  DialogComboboxOpenChangeDetails,
  DialogComboboxOpenChangeReason,
  DialogComboboxOptions,
  DialogComboboxState,
} from "./dialog-combobox-primitive";
