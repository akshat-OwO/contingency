"use client";

import {
  Select as SelectPrimitive,
  SelectContent as SelectPrimitiveContent,
  SelectGroup as SelectPrimitiveGroup,
  SelectGroupLabel as SelectPrimitiveGroupLabel,
  SelectItem as SelectPrimitiveItem,
  SelectItemIndicator as SelectPrimitiveItemIndicator,
  SelectSeparator as SelectPrimitiveSeparator,
  SelectTrigger as SelectPrimitiveTrigger,
  SelectValue as SelectPrimitiveValue,
} from "@ui-sdk/react/select";
import { ChevronDownIcon, CheckIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

interface ClassName {
  readonly className?: string;
}

/**
 * UI SDK's Select renders in place on the top layer. Its value changes keep
 * Base UI's `(value) => void` shape for every caller here, which reads only
 * the first argument.
 */
const Select = SelectPrimitive;

const SelectGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitiveGroup> & ClassName) => (
  <SelectPrimitiveGroup
    className={cn("scroll-my-1 p-1", className)}
    {...props}
  />
);

/**
 * Base UI handed a function child the selected value. UI SDK hands it the
 * value's state, so the facade unwraps it and keeps every caller unchanged.
 */
const valueChild =
  (render: (value: string | null) => React.ReactNode) =>
  (state: { readonly value: unknown }) =>
    // SAFETY: every Workspace Select is built from string item values.
    render(state.value as string | null);

const SelectValue = ({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitiveValue>, "children"> &
  ClassName & {
    readonly children?:
      | React.ReactNode
      | ((value: string | null) => React.ReactNode);
  }) => (
  <SelectPrimitiveValue
    className={cn("flex flex-1 text-left", className)}
    {...props}
  >
    {/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- Tells the two typed forms of the prop apart; nothing here is external input. */}
    {typeof children === "function" ? valueChild(children) : children}
  </SelectPrimitiveValue>
);

/**
 * The island's filled trigger and its solid list (#744) are the default;
 * `variant="compact"` keeps the 32px trigger and plain list for dense panels.
 */
const islandTriggerClassName =
  "border-island-border bg-island-hover dark:bg-island-hover dark:hover:bg-island-hover w-full rounded-xl px-3 data-[size=default]:h-[38px] focus-visible:border-[#ffc400] focus-visible:ring-[oklch(0.85_0.17_85/0.25)] data-open:border-[#ffc400]";
const islandContentClassName =
  "bg-island-solid rounded-[14px] p-[5px] shadow-island ring-island-border";

const SelectTrigger = ({
  className,
  size = "default",
  variant = "island",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitiveTrigger> &
  ClassName & {
    readonly children?: React.ReactNode;
    size?: "sm" | "default";
    readonly variant?: "compact" | "island";
  }) => (
  // A filled field, like `Input` (#744); more contrast restores the edge.
  <SelectPrimitiveTrigger
    data-size={size}
    className={cn(
      "border-island-border bg-island-hover focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-placeholder:text-muted-foreground dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 contrast-more:border-input flex w-fit items-center justify-between gap-1.5 rounded-lg border py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      variant === "island" && islandTriggerClassName,
      className
    )}
    {...props}
  >
    {children}
    <ChevronDownIcon
      aria-hidden="true"
      className="text-muted-foreground pointer-events-none size-4"
    />
  </SelectPrimitiveTrigger>
);

const SelectContent = ({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignItemWithTrigger = true,
  variant = "island",
  ...props
}: React.ComponentProps<typeof SelectPrimitiveContent> &
  ClassName & {
    readonly children?: React.ReactNode;
    readonly variant?: "compact" | "island";
  }) => (
  <SelectPrimitiveContent
    side={side}
    sideOffset={sideOffset}
    align={align}
    alignItemWithTrigger={alignItemWithTrigger}
    data-align-trigger={alignItemWithTrigger}
    className={cn(
      "bg-popover text-popover-foreground ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 relative isolate m-0 max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border-0 p-0 shadow-md ring-1 duration-100 data-[align-trigger=true]:animate-none",
      variant === "island" && islandContentClassName,
      className
    )}
    {...props}
  >
    {children}
  </SelectPrimitiveContent>
);

/** Names a group of options, as Base UI's group label did. */
const SelectLabel = ({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitiveGroupLabel> & ClassName) => (
  <SelectPrimitiveGroupLabel
    // The label names its group through aria-labelledby. Hidden itself, as
    // Base UI's was, so the tree reads `group "Phones"` with no extra text.
    render={<div data-slot="select-label" aria-hidden="true" />}
    className={cn("text-muted-foreground px-1.5 py-1 text-xs", className)}
    {...props}
  />
);

const SelectItem = ({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitiveItem> &
  ClassName & { readonly children?: React.ReactNode }) => (
  <SelectPrimitiveItem
    className={cn(
      "data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
      className
    )}
    {...props}
  >
    {/*
        UI SDK's SelectItemText prints the item's label, so rich children stay
        in a plain span. The item's label comes from its text or `label`.
      */}
    <span
      data-slot="select-item-text"
      className="flex flex-1 shrink-0 gap-2 whitespace-nowrap"
    >
      {children}
    </span>
    <SelectPrimitiveItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
      <CheckIcon aria-hidden="true" className="pointer-events-none" />
    </SelectPrimitiveItemIndicator>
  </SelectPrimitiveItem>
);

const SelectSeparator = ({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitiveSeparator> & ClassName) => (
  <SelectPrimitiveSeparator
    className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)}
    {...props}
  />
);

/**
 * UI SDK scrolls a long list natively and has no scroll arrows. These stay
 * so the facade's exports hold; they render nothing.
 */
const SelectScrollUpButton = (_props: React.ComponentProps<"div">) => null;

const SelectScrollDownButton = (_props: React.ComponentProps<"div">) => null;

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
