import {
  Popover as PopoverPrimitive,
  PopoverContent as PopoverPrimitiveContent,
  PopoverDescription as PopoverPrimitiveDescription,
  PopoverTitle as PopoverPrimitiveTitle,
  PopoverTrigger as PopoverPrimitiveTrigger,
} from "@ui-sdk/react/popover";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * UI SDK popovers render in place on the browser's top layer, so there is no
 * Portal or Positioner part. `Popover` adds no element of its own.
 */
const Popover = (props: React.ComponentProps<typeof PopoverPrimitive>) => (
  <PopoverPrimitive {...props} />
);

const PopoverTrigger = (
  props: React.ComponentProps<typeof PopoverPrimitiveTrigger>
) => <PopoverPrimitiveTrigger {...props} />;

type PrimitiveAnchor = NonNullable<
  React.ComponentProps<typeof PopoverPrimitiveContent>["anchor"]
>;

/**
 * Base UI took a function that returns the anchor element. UI SDK reads any
 * object with `getBoundingClientRect()` on every position check, so the
 * function becomes one that asks for the element each time.
 */
const anchorOf = (
  anchor: PrimitiveAnchor | (() => Element | null) | undefined
): PrimitiveAnchor | null =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Tells the two typed forms of the prop apart; nothing here is external input.
  typeof anchor === "function"
    ? {
        getBoundingClientRect: () =>
          anchor()?.getBoundingClientRect() ?? new DOMRect(),
      }
    : (anchor ?? null);

const PopoverContent = ({
  anchor,
  className,
  positionerClassName,
  align = "center",
  side = "bottom",
  sideOffset = 4,
  ...props
}: Omit<React.ComponentProps<typeof PopoverPrimitiveContent>, "anchor"> & {
  readonly anchor?: PrimitiveAnchor | (() => Element | null);
  /**
   * Kept for the Base UI facade. The top layer stacks popups by open order,
   * so a z-index no longer lifts one above another; it lands on the content.
   */
  readonly positionerClassName?: string;
  readonly className?: string;
}) => (
  <PopoverPrimitiveContent
    align={align}
    anchor={anchorOf(anchor)}
    side={side}
    sideOffset={sideOffset}
    // Every Workspace popover is an island (#744): opaque, on the island's
    // edge, shadow and 22px radius. More contrast gives it a defined edge.
    className={cn(
      "bg-island-solid text-popover-foreground border-island-border shadow-island contrast-more:border-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 m-0 flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-(--island-radius) border p-2.5 text-sm outline-hidden duration-100",
      positionerClassName,
      className
    )}
    {...props}
  />
);

const PopoverHeader = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    data-slot="popover-header"
    className={cn("flex flex-col gap-0.5 text-sm", className)}
    {...props}
  />
);

const PopoverTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof PopoverPrimitiveTitle> & {
  readonly className?: string;
}) => (
  <PopoverPrimitiveTitle className={cn("font-medium", className)} {...props} />
);

const PopoverDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof PopoverPrimitiveDescription> & {
  readonly className?: string;
}) => (
  <PopoverPrimitiveDescription
    className={cn("text-muted-foreground", className)}
    {...props}
  />
);

export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
