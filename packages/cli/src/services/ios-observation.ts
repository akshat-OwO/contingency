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
  const role = node.kind ?? node.role ?? node.type ?? "unknown";
  const password =
    node.password === true ||
    role === "secure-text-field" ||
    (node.type ?? "").endsWith("SecureTextField");
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
