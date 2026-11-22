"use client";

import { usePart, usePrimitive } from "@ui-sdk/react/primitive";
import type { PartProps } from "@ui-sdk/react/primitive";
import type { VariantProps } from "class-variance-authority";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { copyButton } from "./copy-button-primitive";
import type {
  CopyButtonFallbackState,
  CopyButtonOptions,
  CopyButtonTriggerState,
} from "./copy-button-primitive";

export type CopyButtonProps = CopyButtonOptions &
  Omit<PartProps<"span">, keyof CopyButtonOptions>;

const CopyButton = ({ debug, value, ...props }: CopyButtonProps) => {
  const baseOptions: CopyButtonOptions = { value };
  const handle = usePrimitive(
    copyButton,
    debug === undefined ? baseOptions : { ...baseOptions, debug }
  );

  return usePart(handle, "root", {}, props, "span");
};

export type CopyButtonTriggerProps = Omit<
  PartProps<"button", CopyButtonTriggerState>,
  "className"
> &
  VariantProps<typeof buttonVariants> & {
    readonly className?: string;
  };

const CopyButtonTrigger = ({
  className,
  size = "island",
  variant = "island",
  ...props
}: CopyButtonTriggerProps) =>
  usePart(
    copyButton,
    "trigger",
    {},
    {
      ...props,
      className: cn(buttonVariants({ className, size, variant })),
    },
    "button"
  );

export type CopyButtonFallbackProps = Omit<
  PartProps<"span", CopyButtonFallbackState>,
  "children" | "className"
> & {
  readonly className?: string;
  readonly message: string;
};

const CopyButtonFallback = ({
  className,
  message,
  ...props
}: CopyButtonFallbackProps) =>
  usePart(
    copyButton,
    "fallback",
    {},
    {
      ...props,
      children: ({ value }) => (
        <>
          <span className="text-destructive block" role="alert">
            {message}
          </span>
          <span className="bg-muted block rounded px-1.5 py-1 font-mono wrap-anywhere select-all">
            {value}
          </span>
        </>
      ),
      className: cn("basis-full space-y-0.5 text-xs", className),
    },
    "span"
  );

/** The visually hidden polite status that says "Copied". */
const CopyButtonStatus = () =>
  usePart(
    copyButton,
    "status",
    {},
    {
      children: ({ copied }: CopyButtonTriggerState) =>
        copied ? "Copied" : "",
      className: "sr-only",
    },
    "span"
  );

export { CopyButton, CopyButtonFallback, CopyButtonStatus, CopyButtonTrigger };
export { copyButton } from "./copy-button-primitive";
export type {
  CopyButtonFallbackState,
  CopyButtonOptions,
  CopyButtonStatus as CopyButtonStatusValue,
  CopyButtonTriggerState,
} from "./copy-button-primitive";
