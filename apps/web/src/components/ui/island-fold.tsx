"use client";

import { usePart, usePrimitive } from "@ui-sdk/react/primitive";
import type { PartProps } from "@ui-sdk/react/primitive";
import type { VariantProps } from "class-variance-authority";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { islandFold } from "./island-fold-primitive";
import type {
  IslandFoldOptions,
  IslandFoldState,
} from "./island-fold-primitive";

export type IslandFoldProps = IslandFoldOptions &
  Omit<PartProps<"div", IslandFoldState>, keyof IslandFoldOptions>;

const IslandFold = ({
  debug,
  defaultOpen,
  onOpenChange,
  open,
  ...props
}: IslandFoldProps) => {
  const baseOptions: IslandFoldOptions = {
    defaultOpen,
    onOpenChange,
    open,
  };
  const handle = usePrimitive(
    islandFold,
    debug === undefined ? baseOptions : { ...baseOptions, debug }
  );

  return usePart(handle, "root", {}, props, "div");
};

export type IslandFoldExpandTriggerProps = Omit<
  PartProps<"button", IslandFoldState>,
  "className"
> &
  VariantProps<typeof buttonVariants> & {
    readonly className?: string;
  };

const IslandFoldExpandTrigger = ({
  className,
  size,
  variant,
  ...props
}: IslandFoldExpandTriggerProps) => {
  const resolvedClassName =
    size === undefined && variant === undefined
      ? className
      : cn(buttonVariants({ className, size, variant }));
  return usePart(
    islandFold,
    "expand-trigger",
    {},
    resolvedClassName === undefined
      ? props
      : { ...props, className: resolvedClassName },
    "button"
  );
};

export type IslandFoldCollapseTriggerProps = Omit<
  PartProps<"button", IslandFoldState>,
  "className"
> &
  VariantProps<typeof buttonVariants> & {
    readonly className?: string;
  };

const IslandFoldCollapseTrigger = ({
  className,
  size = "island",
  variant = "island",
  ...props
}: IslandFoldCollapseTriggerProps) =>
  usePart(
    islandFold,
    "collapse-trigger",
    {},
    {
      ...props,
      className: cn(buttonVariants({ className, size, variant })),
    },
    "button"
  );

export type IslandFoldContentProps = PartProps<"div", IslandFoldState>;

const IslandFoldContent = (props: IslandFoldContentProps) =>
  usePart(islandFold, "content", {}, props, "div");

export {
  IslandFold,
  IslandFoldCollapseTrigger,
  IslandFoldContent,
  IslandFoldExpandTrigger,
};
export { islandFold } from "./island-fold-primitive";
export type {
  IslandFoldChangeDetails,
  IslandFoldChangeReason,
  IslandFoldOptions,
  IslandFoldState,
} from "./island-fold-primitive";
