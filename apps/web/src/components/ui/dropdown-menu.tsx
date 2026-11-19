import {
  Menu as MenuPrimitive,
  MenuCheckboxItem as MenuPrimitiveCheckboxItem,
  MenuContent as MenuPrimitiveContent,
  MenuGroup as MenuPrimitiveGroup,
  MenuGroupLabel as MenuPrimitiveGroupLabel,
  MenuItem as MenuPrimitiveItem,
  MenuItemIndicator as MenuPrimitiveItemIndicator,
  MenuRadioGroup as MenuPrimitiveRadioGroup,
  MenuRadioItem as MenuPrimitiveRadioItem,
  MenuSeparator as MenuPrimitiveSeparator,
  MenuSub as MenuPrimitiveSub,
  MenuSubContent as MenuPrimitiveSubContent,
  MenuSubTrigger as MenuPrimitiveSubTrigger,
  MenuTrigger as MenuPrimitiveTrigger,
} from "@ui-sdk/react/menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

type ClassName = { readonly className?: string };

/**
 * UI SDK menus render in place on the browser's top layer, so there is no
 * Portal or Positioner part. Plain items close the menu; checkbox and radio
 * items stay open unless they pass `closeOnSelect`.
 */
function DropdownMenu(props: React.ComponentProps<typeof MenuPrimitive>) {
  return <MenuPrimitive {...props} />;
}

function DropdownMenuTrigger(
  props: React.ComponentProps<typeof MenuPrimitiveTrigger>
) {
  return <MenuPrimitiveTrigger data-slot="dropdown-menu-trigger" {...props} />;
}

/**
 * The floating islands' solid list (#779), opted into with
 * `variant="island"`. The default look is unchanged.
 */
const islandContentClassName =
  "bg-island-solid ring-island-border shadow-island w-52 rounded-[14px] p-1";
const islandItemClassName =
  "data-highlighted:bg-island-hover data-highlighted:text-foreground h-[34px] gap-2.5 rounded-[10px] px-2.5 font-medium [&_svg:not([class*='text-'])]:text-muted-foreground data-checked:[&>svg:first-child]:text-island-brand";

const MenuVariant = React.createContext<"default" | "island">("default");

const itemClassName =
  "data-highlighted:bg-accent data-highlighted:text-accent-foreground not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground relative flex cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-inset:pl-7 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function DropdownMenuContent({
  align = "start",
  className,
  side = "bottom",
  sideOffset = 4,
  variant = "default",
  ...props
}: React.ComponentProps<typeof MenuPrimitiveContent> &
  ClassName & {
    readonly variant?: "default" | "island";
  }) {
  return (
    <MenuVariant.Provider value={variant}>
      <MenuPrimitiveContent
        align={align}
        className={cn(
          "bg-popover text-popover-foreground ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 m-0 max-h-(--available-height) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border-0 p-1 shadow-md ring-1 duration-100 outline-none",
          variant === "island" && islandContentClassName,
          className
        )}
        data-slot="dropdown-menu-content"
        side={side}
        sideOffset={sideOffset}
        {...props}
      />
    </MenuVariant.Provider>
  );
}

function DropdownMenuGroup(
  props: React.ComponentProps<typeof MenuPrimitiveGroup>
) {
  return <MenuPrimitiveGroup data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof MenuPrimitiveGroupLabel> &
  ClassName & {
    readonly inset?: boolean;
  }) {
  return (
    <MenuPrimitiveGroupLabel
      className={cn(
        "text-muted-foreground px-1.5 py-1 text-xs font-medium data-inset:pl-7",
        className
      )}
      data-inset={inset}
      data-slot="dropdown-menu-label"
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof MenuPrimitiveItem> &
  ClassName & {
    readonly inset?: boolean;
    readonly variant?: "default" | "destructive";
  }) {
  const menu = React.useContext(MenuVariant);
  return (
    <MenuPrimitiveItem
      className={cn(
        itemClassName,
        "data-[variant=destructive]:text-destructive data-[variant=destructive]:data-highlighted:bg-destructive/10 data-[variant=destructive]:data-highlighted:text-destructive dark:data-[variant=destructive]:data-highlighted:bg-destructive/20 data-[variant=destructive]:*:[svg]:text-destructive",
        menu === "island" && islandItemClassName,
        className
      )}
      data-inset={inset}
      data-slot="dropdown-menu-item"
      data-variant={variant}
      destructive={variant === "destructive"}
      {...props}
    />
  );
}

function DropdownMenuSub(props: React.ComponentProps<typeof MenuPrimitiveSub>) {
  return <MenuPrimitiveSub {...props} />;
}

function DropdownMenuSubTrigger({
  children,
  className,
  inset,
  ...props
}: React.ComponentProps<typeof MenuPrimitiveSubTrigger> &
  ClassName & {
    readonly children?: React.ReactNode;
    readonly inset?: boolean;
  }) {
  return (
    <MenuPrimitiveSubTrigger
      className={cn(
        itemClassName,
        "data-open:bg-accent data-open:text-accent-foreground",
        className
      )}
      data-inset={inset}
      data-slot="dropdown-menu-sub-trigger"
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </MenuPrimitiveSubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitiveSubContent> & ClassName) {
  return (
    <MenuPrimitiveSubContent
      className={cn(
        "bg-popover text-popover-foreground ring-foreground/10 m-0 w-auto min-w-24 rounded-lg border-0 p-1 shadow-lg ring-1",
        className
      )}
      data-slot="dropdown-menu-sub-content"
      {...props}
    />
  );
}

/** A check on the right while the item is on, as Base UI's indicator was. */
const Check = () => (
  <span
    className="pointer-events-none absolute right-2 flex items-center justify-center"
    data-slot="dropdown-menu-item-indicator"
  >
    <MenuPrimitiveItemIndicator>
      <CheckIcon className="text-foreground size-4" />
    </MenuPrimitiveItemIndicator>
  </span>
);

function DropdownMenuCheckboxItem({
  children,
  className,
  inset,
  ...props
}: React.ComponentProps<typeof MenuPrimitiveCheckboxItem> &
  ClassName & {
    readonly children?: React.ReactNode;
    readonly inset?: boolean;
  }) {
  const menu = React.useContext(MenuVariant);
  return (
    <MenuPrimitiveCheckboxItem
      className={cn(
        itemClassName,
        "pr-8",
        menu === "island" && islandItemClassName,
        className
      )}
      data-inset={inset}
      data-slot="dropdown-menu-checkbox-item"
      {...props}
    >
      {children}
      <Check />
    </MenuPrimitiveCheckboxItem>
  );
}

function DropdownMenuRadioGroup(
  props: React.ComponentProps<typeof MenuPrimitiveRadioGroup>
) {
  return (
    <MenuPrimitiveRadioGroup data-slot="dropdown-menu-radio-group" {...props} />
  );
}

function DropdownMenuRadioItem({
  children,
  className,
  inset,
  ...props
}: React.ComponentProps<typeof MenuPrimitiveRadioItem> &
  ClassName & {
    readonly children?: React.ReactNode;
    readonly inset?: boolean;
  }) {
  const menu = React.useContext(MenuVariant);
  return (
    <MenuPrimitiveRadioItem
      className={cn(
        itemClassName,
        "pr-8",
        menu === "island" && islandItemClassName,
        className
      )}
      data-inset={inset}
      data-slot="dropdown-menu-radio-item"
      {...props}
    >
      {children}
      <Check />
    </MenuPrimitiveRadioItem>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof MenuPrimitiveSeparator> & ClassName) {
  return (
    <MenuPrimitiveSeparator
      className={cn("bg-border -mx-1 my-1 h-px", className)}
      data-slot="dropdown-menu-separator"
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "text-muted-foreground ml-auto text-xs tracking-widest",
        className
      )}
      data-slot="dropdown-menu-shortcut"
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
