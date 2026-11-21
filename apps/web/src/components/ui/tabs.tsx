import {
  Tabs as TabsPrimitive,
  TabsList as TabsListPrimitive,
  TabsPanel,
  TabsTab,
} from "@ui-sdk/react/tabs";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

/** The parts accept a class list only, never a function of their state. */
type Styled<P> = Omit<P, "className"> & { readonly className?: string };

const Tabs = ({
  className,
  orientation = "horizontal",
  ...props
}: Styled<React.ComponentProps<typeof TabsPrimitive>>) => (
  <TabsPrimitive
    data-slot="tabs"
    orientation={orientation}
    className={cn(
      "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
      className
    )}
    {...props}
  />
);

const tabsListVariants = cva(
  "group/tabs-list text-muted-foreground inline-flex w-fit items-center justify-center rounded-lg p-[3px] group-data-[orientation=horizontal]/tabs:h-8 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
  {
    defaultVariants: {
      variant: "segmented",
    },
    variants: {
      variant: {
        // The Flows page's file tabs (#755): monospace names on an underline.
        // A package with many files scrolls sideways rather than clipping.
        file: "border-island-border h-auto! max-w-full [scrollbar-width:thin] gap-0.5 overflow-x-auto overflow-y-hidden rounded-none border-b bg-transparent p-0 px-3",
        // Equal segments on an island well, as in the Run Summary (#757), so
        // the content above never moves when a tab opens.
        segmented:
          "bg-island-hover ring-island-border grid h-auto! w-full auto-cols-fr grid-flow-col gap-0.5 rounded-xl p-[3px] ring-1 ring-inset",
      },
    },
  }
);

const TabsList = ({
  className,
  variant = "segmented",
  ...props
}: Styled<React.ComponentProps<typeof TabsListPrimitive>> &
  VariantProps<typeof tabsListVariants>) => (
  <TabsListPrimitive
    data-slot="tabs-list"
    data-variant={variant}
    className={cn(tabsListVariants({ variant }), className)}
    {...props}
  />
);

/** UI SDK marks the chosen tab with `data-selected=""`, so variants test presence. */
const TabsTrigger = ({
  className,
  ...props
}: Styled<React.ComponentProps<typeof TabsTab>>) => (
  <TabsTab
    data-slot="tabs-trigger"
    className={cn(
      "text-foreground/60 hover:text-foreground focus-visible:border-ring focus-visible:ring-ring/30 focus-visible:outline-ring dark:text-muted-foreground dark:hover:text-foreground relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap transition group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start focus-visible:ring-[3px] focus-visible:outline-1 disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      "data-[selected]:text-foreground",
      "after:bg-foreground after:absolute after:opacity-0 after:transition-opacity group-data-[orientation=horizontal]/tabs:after:inset-x-0 group-data-[orientation=horizontal]/tabs:after:bottom-[-5px] group-data-[orientation=horizontal]/tabs:after:h-0.5 group-data-[orientation=vertical]/tabs:after:inset-y-0 group-data-[orientation=vertical]/tabs:after:-right-1 group-data-[orientation=vertical]/tabs:after:w-0.5",
      "group-data-[variant=segmented]/tabs-list:data-[selected]:bg-island-solid group-data-[variant=segmented]/tabs-list:data-[selected]:ring-island-border group-data-[variant=segmented]/tabs-list:h-[30px] group-data-[variant=segmented]/tabs-list:rounded-[9px] group-data-[variant=segmented]/tabs-list:px-2 group-data-[variant=segmented]/tabs-list:text-[12.5px] group-data-[variant=segmented]/tabs-list:data-[selected]:shadow-sm group-data-[variant=segmented]/tabs-list:data-[selected]:ring-1 group-data-[variant=segmented]/tabs-list:data-[selected]:ring-inset",
      "group-data-[variant=file]/tabs-list:h-8 group-data-[variant=file]/tabs-list:flex-none group-data-[variant=file]/tabs-list:rounded-none group-data-[variant=file]/tabs-list:px-2.5 group-data-[variant=file]/tabs-list:font-mono group-data-[variant=file]/tabs-list:text-[12.5px] group-data-[variant=file]/tabs-list:after:bottom-0 group-data-[variant=file]/tabs-list:data-[selected]:after:opacity-100 group-data-[variant=file]/tabs-list:[&_svg:not([class*='size-'])]:size-3.5",
      className
    )}
    {...props}
  />
);

const TabsContent = ({
  className,
  ...props
}: Styled<React.ComponentProps<typeof TabsPanel>>) => (
  <TabsPanel
    data-slot="tabs-content"
    className={cn("flex-1 text-sm outline-none", className)}
    {...props}
  />
);

export { Tabs, TabsList, TabsTrigger, TabsContent };
