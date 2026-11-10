import type { SnapshotNode } from "agent-device";

/**
 * UIKit kinds a person activates directly. XCTest also reports static text,
 * images, and containers as hittable, so the device flag alone would make every
 * label a teachable target. Containers whose parts are separate elements, such
 * as a segmented control or stepper, are left out: their segments and
 * increment buttons are the targets, and tapping the container dispatches
 * nothing.
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "cell",
  "switch",
  "toggle",
  "checkbox",
  "radio",
  "slider",
  "pickerwheel",
  "menu-item",
  "menuitem",
  "search",
]);

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
  const interactive = editable || INTERACTIVE_ROLES.has(role);
  return {
    covered:
      node.enabled === false ||
      node.interactionBlocked === "covered" ||
      (interactive && node.hittable === false),
    editable,
    hittable: interactive && node.hittable !== false,
    password,
    role,
  };
};

type NamedNode = Pick<
  SnapshotNode,
  "label" | "value" | "identifier" | "kind" | "type" | "depth" | "password"
>;

/**
 * The name a person hears for a node. A UITableView or UICollectionView cell
 * usually carries no label of its own; VoiceOver reads its text children
 * instead, so an unlabelled cell takes the text of its descendants.
 */
export const iosNodeName = (
  nodes: readonly NamedNode[],
  index: number
): string => {
  const node = nodes[index];
  if (node === undefined) {
    return "";
  }
  const own = node.label ?? node.value ?? node.identifier;
  if (own !== undefined && own.trim() !== "") {
    return own;
  }
  if (node.kind !== "cell" || node.depth === undefined) {
    return own ?? "";
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
