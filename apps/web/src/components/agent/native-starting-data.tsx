import type { StartingData } from "@contingency/protocol";

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
 * start the way Teaching did.
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
}) => (
  <fieldset className="space-y-2">
    <legend className={legend ? "text-sm font-medium" : "sr-only"}>
      Starting data
    </legend>
    {CHOICES.map((choice) => (
      <label className="flex items-start gap-2 text-sm" key={choice.value}>
        <input
          {...(value === undefined
            ? { defaultChecked: choice.value === "keep" }
            : { checked: value === choice.value })}
          className="mt-0.5"
          name={name}
          onChange={() => onChange?.(choice.value)}
          type="radio"
          value={choice.value}
        />
        <span>
          {choice.label}
          <span className="text-muted-foreground block text-xs text-pretty">
            {choice.description}
          </span>
        </span>
      </label>
    ))}
  </fieldset>
);
