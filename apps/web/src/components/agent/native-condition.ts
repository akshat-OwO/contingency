/** A role and accessible name that gate the start or prove the finish. */
export interface NativeCondition {
  readonly name: string;
  readonly role: string;
}

/** A condition nobody declared yet: the agent chooses one instead. */
export const EMPTY_CONDITION: NativeCondition = { name: "", role: "text" };

/** A condition as the selection carries it: its name trimmed. */
export const trimmedCondition = (
  condition: NativeCondition
): NativeCondition => ({ name: condition.name.trim(), role: condition.role });
