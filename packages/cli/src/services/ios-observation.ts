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

type ActivatedNode = Pick<
  SnapshotNode,
  "index" | "kind" | "identifier" | "rect" | "parentIndex"
>;

/**
 * UIKit draws a UISwitch and a UIStepper at their intrinsic size from the
 * leading top corner of a frame that a stack view stretched, while XCTest
 * reports the stretched frame. On an iOS 26.5 simulator the switch measured
 * 63x28 and the stepper 92x32; UIKit before iOS 26 draws them 51x31 and 94x32.
 * `drawn` is the area every one of those sizes covers, and `fits` is the widest
 * frame that is the control itself rather than a stretched row.
 */
const SWITCH = { drawn: { height: 28, width: 51 }, fits: 63 } as const;
const STEPPER = { drawn: { height: 32, width: 92 }, fits: 94 } as const;

const leadingPoint = (
  rect: NonNullable<ActivatedNode["rect"]>,
  size: { readonly width: number; readonly height: number },
  x: number
) => ({
  x: Math.round(rect.x + x),
  y: Math.round(rect.y + Math.min(rect.height, size.height) / 2),
});

/**
 * The point to tap for a switch or stepper button whose reported frame is wider
 * than the control UIKit draws, in snapshot points. Every other node, and a
 * control whose frame fits it, keeps agent-device's frame-center tap (null).
 */
export const iosActivationPoint = (
  nodes: readonly ActivatedNode[],
  target: ActivatedNode
): { readonly x: number; readonly y: number } | null => {
  const { rect } = target;
  if (rect === undefined) {
    return null;
  }
  if (target.kind === "switch") {
    return rect.width > SWITCH.fits
      ? leadingPoint(rect, SWITCH.drawn, SWITCH.drawn.width / 2)
      : null;
  }
  const stepper = nodes.find((node) => node.index === target.parentIndex);
  if (
    target.kind !== "button" ||
    stepper?.kind !== "stepper" ||
    stepper.rect === undefined ||
    stepper.rect.width <= STEPPER.fits
  ) {
    return null;
  }
  const buttons = nodes.filter(
    (node) => node.parentIndex === stepper.index && node.kind === "button"
  );
  const increment =
    target.identifier === "Increment" ||
    (target.identifier !== "Decrement" && buttons.at(-1) === target);
  // Each half of the stepper is one button: decrement leading, increment trailing.
  return leadingPoint(
    stepper.rect,
    STEPPER.drawn,
    (STEPPER.drawn.width / 4) * (increment ? 3 : 1)
  );
};
