import {
  Dialog as SheetPrimitive,
  DialogBackdrop as SheetPrimitiveBackdrop,
  DialogClose as SheetPrimitiveClose,
  DialogContent as SheetPrimitiveContent,
  DialogDescription as SheetPrimitiveDescription,
  DialogTitle as SheetPrimitiveTitle,
  DialogTrigger as SheetPrimitiveTrigger,
} from "@ui-sdk/react/dialog";
import { XIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ClassName = { readonly className?: string };

/**
 * A side panel built on UI SDK's Dialog, as it was on Base UI's. UI SDK's
 * Drawer adds swipe physics and snap points the Workspace does not use.
 */
function Sheet(props: React.ComponentProps<typeof SheetPrimitive>) {
  return <SheetPrimitive {...props} />;
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitiveTrigger>) {
  return (
    <SheetPrimitiveTrigger render={<button data-slot="sheet-trigger" />} {...props} />
  );
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitiveClose>) {
  return (
    <SheetPrimitiveClose render={<button data-slot="sheet-close" />} {...props} />
  );
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitiveBackdrop> & ClassName) {
  return (
    <SheetPrimitiveBackdrop
      render={<div data-slot="sheet-overlay" />}
      className={cn(
        "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      {...props}
    />
  );
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof SheetPrimitiveContent> &
  ClassName & {
    readonly children?: React.ReactNode;
    side?: "top" | "right" | "bottom" | "left";
    showCloseButton?: boolean;
  }) {
  return (
    <>
      <SheetOverlay />
      <SheetPrimitiveContent
        render={<div data-slot="sheet-content" data-side={side} />}
        className={cn(
          "bg-popover text-popover-foreground fixed z-50 m-0 flex max-h-none max-w-none flex-col gap-4 border-0 bg-clip-padding p-0 text-sm shadow-lg transition duration-200 ease-in-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:top-auto data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=left]:inset-y-0 data-[side=left]:right-auto data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:left-auto data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:bottom-auto data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitiveClose
            render={
              <Button
                data-slot="sheet-close"
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitiveClose>
        )}
      </SheetPrimitiveContent>
    </>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitiveTitle> & ClassName) {
  return (
    <SheetPrimitiveTitle
      render={<h2 data-slot="sheet-title" />}
      className={cn(
        "font-heading text-foreground text-base font-medium",
        className
      )}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitiveDescription> & ClassName) {
  return (
    <SheetPrimitiveDescription
      render={<p data-slot="sheet-description" />}
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
