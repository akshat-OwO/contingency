"use client";

import {
  Dialog as DialogPrimitive,
  DialogBackdrop as DialogPrimitiveBackdrop,
  DialogClose as DialogPrimitiveClose,
  DialogContent as DialogPrimitiveContent,
  DialogDescription as DialogPrimitiveDescription,
  DialogTitle as DialogPrimitiveTitle,
  DialogTrigger as DialogPrimitiveTrigger,
} from "@ui-sdk/react/dialog";
import { XIcon } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ClassName {
  readonly className?: string;
}

const Dialog = (props: React.ComponentProps<typeof DialogPrimitive>) => (
  <DialogPrimitive {...props} />
);

const DialogTrigger = (
  props: React.ComponentProps<typeof DialogPrimitiveTrigger>
) => <DialogPrimitiveTrigger {...props} />;

/**
 * UI SDK dialogs render in place on the top layer, so a portal has nothing
 * to do. Kept so the facade's export names stay stable.
 */
const DialogPortal = ({ children }: { readonly children?: React.ReactNode }) =>
  children;

const DialogClose = (
  props: React.ComponentProps<typeof DialogPrimitiveClose>
) => <DialogPrimitiveClose {...props} />;

const DialogOverlay = ({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitiveBackdrop> & ClassName) => (
  <DialogPrimitiveBackdrop
    render={<div data-slot="dialog-overlay" />}
    className={cn(
      "data-open:animate-in data-open:fade-in-0 data-ending-style:animate-out data-ending-style:fade-out-0 fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs",
      className
    )}
    {...props}
  />
);

/** The dialog's own surface, unstyled, for a layout the card does not fit. */
const DialogPopup = (
  props: React.ComponentProps<typeof DialogPrimitiveContent>
) => <DialogPrimitiveContent {...props} />;

const DialogContent = ({
  className,
  children,
  showCloseButton = true,
  showOverlay = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitiveContent> &
  ClassName & {
    readonly children?: React.ReactNode;
    showCloseButton?: boolean;
    /** A non-modal dialog leaves the page usable, so it has no backdrop. */
    showOverlay?: boolean;
  }) => (
  <>
    {showOverlay ? <DialogOverlay /> : null}
    <DialogPrimitiveContent
      className={cn(
        "bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-ending-style:animate-out data-ending-style:fade-out-0 data-ending-style:zoom-out-95 fixed top-1/2 left-1/2 z-50 m-0 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border-0 p-4 text-sm ring-1 duration-100 outline-none sm:max-w-sm",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitiveClose
          render={
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            />
          }
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogPrimitiveClose>
      )}
    </DialogPrimitiveContent>
  </>
);

const DialogHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div
    data-slot="dialog-header"
    className={cn("flex flex-col gap-2", className)}
    {...props}
  />
);

const DialogFooter = ({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) => (
  <div
    data-slot="dialog-footer"
    className={cn(
      "bg-muted/50 -mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t p-4 sm:flex-row sm:justify-end",
      className
    )}
    {...props}
  >
    {children}
    {showCloseButton && (
      <DialogPrimitiveClose render={<Button size="md" variant="outline" />}>
        Close
      </DialogPrimitiveClose>
    )}
  </div>
);

const DialogTitle = ({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitiveTitle> & ClassName) => (
  <DialogPrimitiveTitle
    className={cn("font-heading text-base leading-none font-medium", className)}
    {...props}
  />
);

const DialogDescription = ({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitiveDescription> & ClassName) => (
  <DialogPrimitiveDescription
    className={cn(
      "text-muted-foreground *:[a]:hover:text-foreground text-sm *:[a]:underline *:[a]:underline-offset-3",
      className
    )}
    {...props}
  />
);

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
