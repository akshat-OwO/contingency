import type { AndroidWorkspaceCommand } from "@contingency/protocol";

import type { ExecutionBoundary } from "./execution-boundary.ts";

/** Both native runtimes use one exact-action grant per agent attempt. */
export const checkNativeAppConfirmation = (
  boundary: ExecutionBoundary,
  platform: "android" | "ios",
  command: Extract<AndroidWorkspaceCommand, { readonly _tag: "input" }>,
  objective: string,
  selectedTarget:
    | {
        readonly role: string;
        readonly name: string;
        readonly packageName: string | null;
      }
    | undefined
) => {
  const { action } = command;
  const capturedAction = { action: JSON.stringify(action), type: platform };
  return boundary.checkAttempt({
    action: capturedAction,
    capturedAction,
    description:
      action._tag === "back"
        ? "Go back"
        : `${action._tag === "activate" ? "Activate" : "Fill"} ${selectedTarget?.role} ${JSON.stringify(selectedTarget?.name)}${selectedTarget?.packageName ? ` in ${selectedTarget.packageName}` : ""}`,
    intent: { irreversible: command.irreversible === true },
    objective,
    operationId: command.operationId,
    step: undefined,
  });
};
