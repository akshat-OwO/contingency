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

/**
 * A combobox's name never comes from its text, which shows the current choice,
 * so the trigger takes `aria-label` or `aria-labelledby`.
 * https://www.w3.org/WAI/ARIA/apg/patterns/combobox/#wai-ariaroles,states,andproperties
 */
type DialogComboboxTriggerName =
  | { readonly "aria-label": string; readonly "aria-labelledby"?: never }
  | { readonly "aria-label"?: never; readonly "aria-labelledby": string };

export type DialogComboboxTriggerProps = Omit<
  PartProps<"button", DialogComboboxState>,
  "aria-label" | "aria-labelledby" | "render"
> &
  DialogComboboxTriggerName & {
    /** The element to render, as on `PopoverTrigger`, like a `Button`. */
    readonly render?: NonNullable<
      React.ComponentProps<typeof PopoverTrigger>["render"]
    >;
  };

/**
 * The combobox, rendered through the Popover's trigger. Its children show the
 * current choice; `aria-label` or `aria-labelledby` names it.
 */
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
