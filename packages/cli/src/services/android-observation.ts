import type { SnapshotNode } from "agent-device";

/**
 * Android's accessibility facts as an observation reads them. Unlike UIKit,
 * the platform reports clickability itself, so a clickable container keeps
 * the device's verdict; `androidNodeName` supplies its name.
 */
export const androidNodeInteraction = (
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
) => ({
  covered: node.interactionBlocked === "covered" || node.enabled === false,
  editable: node.editable === true,
  hittable: node.hittable === true,
  password: node.password === true,
  role: node.kind ?? node.role ?? node.type ?? "unknown",
});

type NamedNode = Pick<
  SnapshotNode,
  "label" | "kind" | "depth" | "hittable" | "password"
>;

/**
 * The name TalkBack reads for a node. A clickable container that carries no
 * label of its own, such as a hand-built list row, is announced by the text
 * of its children, so it takes that text here too.
 */
export const androidNodeName = (
  nodes: readonly NamedNode[],
  index: number
): string => {
  const node = nodes[index];
  if (node === undefined) {
    return "";
  }
  const own = node.label ?? "";
  if (own.trim() !== "" || node.hittable !== true || node.depth === undefined) {
    return own;
  }
  const parts: string[] = [];
  for (const child of nodes.slice(index + 1)) {
    if (child.depth === undefined || child.depth <= node.depth) {
      break;
    }
    const text = child.kind === "text" ? child.label?.trim() : undefined;
    if (text !== undefined && text !== "" && child.password !== true) {
      parts.push(text);
    }
  }
  return parts.join(", ");
};
