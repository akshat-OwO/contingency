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
  // A Home Screen app icon: agent-device leaves XCUIElementType 44 unmapped.
  "icon",
  "element(44)",
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
    | "rect"
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
  // XCTest reports an element on another Home Screen page, or otherwise off
  // screen, with an empty frame. Nothing on screen answers a tap there.
  const offscreen =
    node.rect !== undefined && (node.rect.width <= 0 || node.rect.height <= 0);
  return {
    covered:
      offscreen ||
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
  "index" | "kind" | "identifier" | "rect" | "parentIndex" | "role" | "type"
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

type Rect = NonNullable<ActivatedNode["rect"]>;
const area = (rect: Rect) => rect.width * rect.height;
const contains = (rect: Rect, point: { x: number; y: number }) =>
  point.x > rect.x &&
  point.x < rect.x + rect.width &&
  point.y > rect.y &&
  point.y < rect.y + rect.height;
const kindOf = (node: ActivatedNode) => node.kind ?? node.role ?? node.type;
/** Each node's ancestors, by index. */
const lineage = (nodes: readonly ActivatedNode[], node: ActivatedNode) => {
  const byIndex = new Map(nodes.map((each) => [each.index, each]));
  const ancestors = new Set<number>();
  for (
    let parent = byIndex.get(node.parentIndex ?? -1);
    parent !== undefined && !ancestors.has(parent.index);
    parent = byIndex.get(parent.parentIndex ?? -1)
  ) {
    ancestors.add(parent.index);
  }
  return ancestors;
};
/** Fractions of a frame to try, nearest its centre first. */
const OFFSETS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9];

/**
 * A point on the part of the frame no overlapping peer covers: the App
 * Switcher stacks each app's card partly over the one before, so the older
 * card's centre is the newer card. XCTest does not say which is drawn on top,
 * so a point only the target's frame holds is the one tap that reaches it
 * either way. A peer is an unrelated node of the same kind and of comparable
 * size; containers and labels are not peers. With no peer over the centre, or
 * no uncovered point, the frame centre stays (null).
 */
const uncoveredPoint = (
  nodes: readonly ActivatedNode[],
  target: ActivatedNode,
  rect: Rect
) => {
  const size = area(rect);
  if (size <= 0) {
    return null;
  }
  const own = lineage(nodes, target);
  const peers = nodes.flatMap((node) =>
    node !== target &&
    node.rect !== undefined &&
    kindOf(node) === kindOf(target) &&
    !own.has(node.index) &&
    !lineage(nodes, node).has(target.index) &&
    area(node.rect) >= size / 2 &&
    area(node.rect) <= size * 2
      ? [node.rect]
      : []
  );
  const covered = (point: { x: number; y: number }) =>
    peers.some((peer) => contains(peer, point));
  const at = (fx: number, fy: number) => ({
    x: Math.round(rect.x + rect.width * fx),
    y: Math.round(rect.y + rect.height * fy),
  });
  if (!covered(at(0.5, 0.5))) {
    return null;
  }
  for (const fy of OFFSETS) {
    for (const fx of OFFSETS) {
      const point = at(fx, fy);
      if (!covered(point)) {
        return point;
      }
    }
  }
  return null;
};

/**
 * The point to tap for a switch or stepper button whose reported frame is wider
 * than the control UIKit draws, or for a node a peer partly covers, in
 * snapshot points. Every other node, and a control whose frame fits it, keeps
 * agent-device's frame-center tap (null).
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
    return uncoveredPoint(nodes, target, rect);
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
