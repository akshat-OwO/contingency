import { randomUUID } from "node:crypto";

import type {
  NativeAppEnvironmentDifference,
  NativeAppRunDecision,
} from "./native-app-run-contract.ts";

/** Comparison never changes the taught environment or waives preparation. */
export const compareNativeAppEnvironments = <
  Field extends string,
  Value,
>(input: {
  readonly taught: Readonly<Partial<Record<Field, Value>>>;
  readonly selected: Readonly<Partial<Record<Field, Value>>>;
  readonly fields: readonly Field[];
  readonly display: (field: Field, value: Value | undefined) => string;
}): NativeAppEnvironmentDifference<Field>[] =>
  input.fields.flatMap((field) =>
    JSON.stringify(input.taught[field] ?? []) ===
    JSON.stringify(input.selected[field] ?? [])
      ? []
      : [
          {
            field,
            selected: input.display(field, input.selected[field]),
            taught: input.display(field, input.taught[field]),
          },
        ]
  );

export const nativeAppEnvironmentPermission = <
  Difference extends NativeAppEnvironmentDifference,
>(input: {
  readonly runId: string;
  readonly targetApp: string;
  readonly differences: readonly Difference[];
  readonly requiresPermission: (difference: Difference) => boolean;
}): NativeAppRunDecision<Difference>[] =>
  input.differences.some(input.requiresPermission)
    ? [
        {
          differences: input.differences,
          id: randomUUID(),
          kind: "run-environment-permission",
          runId: input.runId,
          targetApp: input.targetApp,
        },
      ]
    : [];
