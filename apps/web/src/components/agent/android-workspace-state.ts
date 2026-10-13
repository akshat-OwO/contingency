import type { AndroidWorkspaceSelection } from "@contingency/protocol";

const actionLine = /^(?<role>[^:]+):(?<name>.+)$/u;

/**
 * Reads one `role: name` declaration per line. Blank lines are ignored; any
 * malformed line rejects the whole list so no declared control is dropped.
 */
export const parseReversibleActions = (
  text: string
): AndroidWorkspaceSelection["reversibleActions"] | undefined => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const actions = lines.flatMap((line) => {
    const groups = actionLine.exec(line)?.groups;
    const role = groups?.role?.trim();
    const name = groups?.name?.trim();
    return role && name ? [{ name, role }] : [];
  });
  return actions.length === lines.length ? actions : undefined;
};
