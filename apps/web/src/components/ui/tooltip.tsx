"use client";

import {
  Tooltip as TooltipPrimitive,
  TooltipArrow as TooltipPrimitiveArrow,
  TooltipContent as TooltipPrimitiveContent,
  TooltipTrigger as TooltipPrimitiveTrigger,
} from "@ui-sdk/react/tooltip";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * UI SDK groups tooltips without a provider: one opens at once while another
 * was just open. The provider stays in the facade only to carry the default
 * delay every tooltip below it starts with.
 */
const TooltipDelay = React.createContext(0);

function TooltipProvider({
  delay = 0,
  children,
}: {
  readonly delay?: number;
  readonly children?: React.ReactNode;
}) {
  return <TooltipDelay value={delay}>{children}</TooltipDelay>;
}

function Tooltip({
  delay,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive>) {
  const inherited = React.use(TooltipDelay);
  return <TooltipPrimitive delay={delay ?? inherited} {...props} />;
}

function TooltipTrigger(
  props: React.ComponentProps<typeof TooltipPrimitiveTrigger>
) {
  return <TooltipPrimitiveTrigger {...props} />;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitiveContent> & {
  readonly className?: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <TooltipPrimitiveContent
      align={align}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        "bg-foreground text-background data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 m-0 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 overflow-visible rounded-md border-0 px-3 py-1.5 text-xs has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm",
        className
      )}
      {...props}
    >
      {children}
      <TooltipPrimitiveArrow className="bg-foreground absolute z-50 size-2.5 rotate-45 rounded-[2px] data-[side=bottom]:-top-1 data-[side=left]:top-1/2 data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2 data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-1" />
    </TooltipPrimitiveContent>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
