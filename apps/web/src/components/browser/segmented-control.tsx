import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SegmentedOption<Value extends string> {
  readonly count?: number | undefined;
  readonly label: ReactNode;
  readonly value: Value;
}

const NEXT_KEYS = new Set(["ArrowDown", "ArrowRight"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

/** Where an arrow, Home, or End key moves the checked option, if anywhere. */
const movedIndex = (key: string, current: number, count: number) => {
  if (NEXT_KEYS.has(key)) {
    return (current + 1) % count;
  }
  if (PREVIOUS_KEYS.has(key)) {
    return (current - 1 + count) % count;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return count - 1;
  }
  return null;
};

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
}) => {
  const checkedIndex = options.findIndex((option) => option.value === value);
  // The radio pattern: one tab stop for the group, arrows move and check.
  const focusIndex = Math.max(checkedIndex, 0);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = movedIndex(event.key, focusIndex, options.length);
    const option = next === null ? undefined : options[next];
    if (next === null || option === undefined) {
      return;
    }
    event.preventDefault();
    onChange(option.value);
    const radios =
      event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    radios.item(next)?.focus();
  };
  return (
    <div
      aria-disabled={disabled}
      aria-label={label}
      className={cn(
        "bg-muted/70 inline-flex items-center gap-0.5 rounded-lg p-0.5 aria-disabled:opacity-50",
        className
      )}
      onKeyDown={disabled ? undefined : onKeyDown}
      role="radiogroup"
    >
      {options.map((option, index) => {
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
            tabIndex={index === focusIndex ? 0 : -1}
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
};
