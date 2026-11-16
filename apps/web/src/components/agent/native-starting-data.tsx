import type { StartingData } from "@contingency/protocol";
import { useId } from "react";

import { Radio, RadioGroup } from "@/components/ui/radio";

const CHOICES = [
  {
    description:
      "Start from whatever the app already has on this device, including its sign-in.",
    label: "Keep current data",
    value: "keep",
  },
  {
    description:
      "Remove this app's sign-in and local data before Teaching and before every later Run. Other apps and the device are unchanged.",
    label: "Clear app data",
    value: "clear",
  },
] as const satisfies readonly {
  readonly description: string;
  readonly label: string;
  readonly value: StartingData;
}[];

/**
 * The Flow's Starting Data (ADR 0081), saved with it so Dry Runs and Runs
 * start the way Teaching did. Each choice is a card whose whole face checks
 * its radio; the group submits its value under `name`.
 */
export const StartingDataField = ({
  legend = true,
  name,
  onChange,
  value,
}: {
  /** False when the surrounding step already names the field. */
  readonly legend?: boolean;
  /** Groups the radios and names the value in a submitted form. */
  readonly name: string;
  /** Omit both to leave the choice to the form, defaulting to Keep. */
  readonly onChange?: (value: StartingData) => void;
  readonly value?: StartingData;
}) => {
  const ids = useId();
  return (
    <div className="grid gap-1.5">
      <span
        className={legend ? "text-[13px] font-medium" : "sr-only"}
        id={`${ids}-legend`}
      >
        Starting data
      </span>
      <RadioGroup<StartingData>
        aria-labelledby={`${ids}-legend`}
        className="grid gap-2 sm:grid-cols-2"
        name={name}
        onValueChange={(next) => {
          if (next !== null) {
            onChange?.(next);
          }
        }}
        {...(value === undefined ? { defaultValue: "keep" } : { value })}
      >
        {CHOICES.map((choice) => (
          <label
            className="border-island-border hover:bg-island-hover has-data-checked:border-foreground/70 has-data-checked:bg-island-hover flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-[13px] has-data-disabled:cursor-not-allowed has-data-disabled:opacity-60"
            key={choice.value}
          >
            <Radio className="mt-0.5" value={choice.value} />
            <span className="grid gap-0.5">
              <span className="font-medium">{choice.label}</span>
              <span className="text-muted-foreground text-xs text-pretty">
                {choice.description}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
};
