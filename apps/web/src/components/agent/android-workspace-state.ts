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

export const androidDeviceLabel = (
  device: AndroidWorkspaceSelection["device"]
) => (device.kind === "physical" ? device.model : device.avd);

const permissionLine =
  /^(?<decision>grant|revoke)\s+(?<permission>android\.permission\.[A-Z_]+)$/u;
export const parseAndroidPermissionDecisions = (
  text: string
):
  | NonNullable<AndroidWorkspaceSelection["environment"]["permissions"]>
  | undefined => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = lines.flatMap((line) => {
    const groups = permissionLine.exec(line)?.groups;
    const permission = groups?.permission;
    const decision = groups?.decision;
    return permission && (decision === "grant" || decision === "revoke")
      ? [
          { decision, permission } satisfies NonNullable<
            AndroidWorkspaceSelection["environment"]["permissions"]
          >[number],
        ]
      : [];
  });
  return entries.length === lines.length &&
    new Set(entries.map((entry) => entry.permission)).size === entries.length
    ? entries
    : undefined;
};
