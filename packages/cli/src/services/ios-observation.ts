import type { SnapshotNode } from "agent-device";

/** UIKit snapshots use semantic kinds where Android's helper supplies explicit field flags. */
export const iosNodeInteraction = (
  node: Pick<
    SnapshotNode,
    | "kind"
    | "role"
    | "type"
    | "editable"
    | "password"
    | "hittable"
    | "enabled"
    | "interactionBlocked"
  >
) => {
  // agent-device leaves UIKit secure fields with the unmapped kind `securetextfield`.
  const secure =
    node.kind === "secure-text-field" ||
    node.kind === "securetextfield" ||
    (node.kind === undefined && (node.type ?? "").endsWith("SecureTextField"));
  const role = secure
    ? "secure-text-field"
    : (node.kind ?? node.role ?? node.type ?? "unknown");
  const password = node.password === true || secure;
  const editable =
    node.editable === true ||
    ["text-field", "secure-text-field", "text-view"].includes(role);
  return {
    covered:
      node.enabled === false ||
      node.interactionBlocked === "covered" ||
      ((editable || role === "button") && node.hittable === false),
    editable,
    hittable:
      (editable || role === "button" || role === "link") &&
      node.hittable !== false,
    password,
    role,
  };
};
