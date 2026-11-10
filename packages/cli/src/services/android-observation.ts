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
  "label" | "kind" | "depth" | "hittable" | "editable" | "password"
>;

/** Kinds that lay out other controls; their padding activates nothing. */
export const COLLECTION_KINDS = new Set([
  "scroll-area",
  "horizontalscrollview",
  "list",
  "gridview",
  "webview",
]);

/**
 * The name TalkBack reads for a node. A clickable row that carries no label
 * of its own, such as a hand-built list row or a settings row with a switch,
 * is announced by the text of its children, so it takes that text here too.
 * Text inside a child control belongs to that control, not to the row. A
 * scroll view or list stays unnamed: its items are the targets.
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
  if (
    own.trim() !== "" ||
    node.hittable !== true ||
    node.depth === undefined ||
    COLLECTION_KINDS.has(node.kind ?? "")
  ) {
    return own;
  }
  const parts: string[] = [];
  let controlDepth: number | undefined;
  for (const child of nodes.slice(index + 1)) {
    if (child.depth === undefined || child.depth <= node.depth) {
      break;
    }
    if (controlDepth !== undefined && child.depth > controlDepth) {
      continue;
    }
    controlDepth = undefined;
    if (child.hittable === true || child.editable === true) {
      controlDepth = child.depth;
      continue;
    }
    const text = child.kind === "text" ? child.label?.trim() : undefined;
    if (text !== undefined && text !== "" && child.password !== true) {
      parts.push(text);
    }
  }
  return parts.join(", ");
};
