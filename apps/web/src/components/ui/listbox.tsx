"use client";

import {
  Listbox as ListboxPrimitive,
  ListboxGroup as ListboxGroupPrimitive,
  ListboxGroupLabel as ListboxGroupLabelPrimitive,
  ListboxItem as ListboxItemPrimitive,
  ListboxItemIcon as ListboxItemIconPrimitive,
  ListboxItemIndicator as ListboxItemIndicatorPrimitive,
  ListboxSeparator as ListboxSeparatorPrimitive,
} from "@ui-sdk/react/listbox";
import type * as React from "react";

import { cn } from "@/lib/utils";

/** The parts accept a class list only, never a function of their state. */
type Styled<P> = Omit<P, "className"> & { readonly className?: string };

/**
 * An always-visible list to choose from: one tab stop, arrow keys, Home, End
 * and typeahead between its options. Name it with `aria-label`,
 * `aria-labelledby` or a Field label. Keep buttons and other controls outside
 * it; its contents are options, groups and separators.
 *
 * Set `activation="manual"` when choosing does something costly, like opening
 * another session, so arrows browse and Enter, Space or a press chooses.
 *
 * It draws nothing of its own, so it is UI SDK's part unchanged; a wrapper
 * would have to restate its single and multiple value types.
 */
const Listbox = ListboxPrimitive;

/**
 * One option. Style the chosen one with `data-selected:`, the focused one
 * with `focus-visible:`, and an unavailable one with `data-disabled:`.
 */
const ListboxItem = <T = string,>({
  className,
  ...props
}: Styled<React.ComponentProps<typeof ListboxItemPrimitive<T>>>) => (
  <ListboxItemPrimitive<T>
    className={cn(
      "cursor-default outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50",
      className
    )}
    {...props}
  />
);

/** Content shown only while its option is chosen, like a check. */
const ListboxItemIndicator = ({
  className,
  ...props
}: Styled<React.ComponentProps<typeof ListboxItemIndicatorPrimitive>>) => (
  <ListboxItemIndicatorPrimitive className={cn(className)} {...props} />
);

/** An icon in an option, left out of its name and typeahead. */
const ListboxItemIcon = ({
  className,
  ...props
}: Styled<React.ComponentProps<typeof ListboxItemIconPrimitive>>) => (
  <ListboxItemIconPrimitive className={cn(className)} {...props} />
);

/** Options under one label. Arrow keys continue across groups. */
const ListboxGroup = ({
  className,
  ...props
}: Styled<React.ComponentProps<typeof ListboxGroupPrimitive>>) => (
  <ListboxGroupPrimitive className={cn(className)} {...props} />
);

/** The visible name of a group. */
const ListboxGroupLabel = ({
  className,
  ...props
}: Styled<React.ComponentProps<typeof ListboxGroupLabelPrimitive>>) => (
  <ListboxGroupLabelPrimitive
    className={cn(
      "text-muted-foreground px-2 py-1 text-xs font-medium",
      className
    )}
    {...props}
  />
);

/** A line between groups, left out of the accessibility tree. */
const ListboxSeparator = ({
  className,
  ...props
}: Styled<React.ComponentProps<typeof ListboxSeparatorPrimitive>>) => (
  <ListboxSeparatorPrimitive
    className={cn("bg-border -mx-1 my-1 h-px", className)}
    {...props}
  />
);

export {
  Listbox,
  ListboxGroup,
  ListboxGroupLabel,
  ListboxItem,
  ListboxItemIcon,
  ListboxItemIndicator,
  ListboxSeparator,
};
export type { ListboxValueChangeReason } from "@ui-sdk/react/listbox";
