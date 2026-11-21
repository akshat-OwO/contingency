"use client";

import {
  Combobox as ComboboxPrimitive,
  ComboboxContent as ComboboxPrimitiveContent,
  ComboboxEmpty as ComboboxPrimitiveEmpty,
  ComboboxInput as ComboboxPrimitiveInput,
  ComboboxItem as ComboboxPrimitiveItem,
  ComboboxItemIndicator as ComboboxPrimitiveItemIndicator,
  ComboboxLabel as ComboboxPrimitiveLabel,
  ComboboxList as ComboboxPrimitiveList,
} from "@ui-sdk/react/combobox";
import { CheckIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

type ClassName = { readonly className?: string };

/**
 * UI SDK's Combobox: an input that filters a list in a popup on the top
 * layer. `Combobox` adds no element of its own.
 */
const Combobox = ComboboxPrimitive;

function ComboboxLabel({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitiveLabel> & ClassName) {
  return (
    <ComboboxPrimitiveLabel
      className={cn("text-[13px] font-medium", className)}
      {...props}
    />
  );
}

/** The filled island field of the Workspace home (#744), like `Input`. */
function ComboboxInput({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitiveInput> & ClassName) {
  return (
    <ComboboxPrimitiveInput
      className={cn(
        "border-island-border bg-island-hover placeholder:text-muted-foreground contrast-more:border-input h-[38px] w-full min-w-0 rounded-xl border px-3 text-sm transition-colors outline-none focus-visible:border-[#ffc400] focus-visible:ring-3 focus-visible:ring-[oklch(0.85_0.17_85/0.25)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

/** The solid island list, as the island Select shows its options. */
function ComboboxContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitiveContent> & ClassName) {
  return (
    <ComboboxPrimitiveContent
      className={cn(
        "bg-island-solid text-popover-foreground shadow-island ring-island-border data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 m-0 max-h-[min(18rem,var(--available-height))] w-(--anchor-width) origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-[14px] border-0 p-[5px] ring-1 duration-100",
        className
      )}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function ComboboxList({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitiveList> & ClassName) {
  return <ComboboxPrimitiveList className={cn("grid", className)} {...props} />;
}

function ComboboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitiveItem> &
  ClassName & { readonly children?: React.ReactNode }) {
  return (
    <ComboboxPrimitiveItem
      className={cn(
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground relative flex w-full min-w-0 cursor-default items-center gap-1.5 rounded-md py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
      <ComboboxPrimitiveItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
        <CheckIcon aria-hidden="true" className="size-4" />
      </ComboboxPrimitiveItemIndicator>
    </ComboboxPrimitiveItem>
  );
}

function ComboboxEmpty({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxPrimitiveEmpty> & ClassName) {
  return (
    <ComboboxPrimitiveEmpty
      className={cn(
        "text-muted-foreground px-2 py-3 text-center text-xs",
        className
      )}
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
};
