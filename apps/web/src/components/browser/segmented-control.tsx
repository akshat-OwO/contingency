import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<Value extends string> {
  readonly count?: number | undefined;
  readonly label: ReactNode;
  readonly value: Value;
}

/**
 * A compact single-choice radio group drawn as a segmented control. It is the
 * one control the browser tooling uses for a short set of mutually exclusive
 * choices, so the inspector reads as one surface.
 */
export const SegmentedControl = <Value extends string>({
  className,
  disabled = false,
  label,
  onChange,
  options,
  size = "sm",
  value,
}: {
  readonly className?: string;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (value: Value) => void;
  readonly options: readonly SegmentedOption<Value>[];
  readonly size?: "sm" | "xs";
  readonly value: Value | undefined;
}) => (
  <div
    aria-disabled={disabled}
    aria-label={label}
    className={cn(
      "bg-muted/70 inline-flex items-center gap-0.5 rounded-lg p-0.5 aria-disabled:opacity-50",
      className
    )}
    role="radiogroup"
  >
    {options.map((option) => {
      const selected = option.value === value;
      return (
        <button
          aria-checked={selected}
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-150 outline-none focus-visible:ring-2 disabled:pointer-events-none",
            size === "sm" ? "h-6 px-2 text-xs" : "h-5 px-1.5 text-xs",
            selected &&
              "bg-background text-foreground shadow-xs dark:bg-white/10"
          )}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
          {option.count === undefined ? null : (
            <span className="text-muted-foreground tabular-nums">
              {option.count}
            </span>
          )}
        </button>
      );
    })}
  </div>
);
